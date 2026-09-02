# Local-first per machine — architecture re-cut plan

**Status:** draft for adversarial review, 2026-09-02. Nothing here is decided or built. Section 2 was reworded at the owner's request shortly after the two adversaries launched; its substance is unchanged.
**Owner:** Ben. **Drafted by:** Claude (Fable 5.1) from a step-back conversation on 2026-09-02, grounded in the live corpus and `origin/main` at `f0af6ae`.
**What this document is for:** a detailed, attackable plan. Two adversaries (one Fable 5.1 session, one Codex session) challenge it before anything is written into the corpus or cut into issues. The corpus record that follows is shorter and more abstract than this.

---

## 0. How to read this, and what to attack

The plan proposes a re-cut of *where authority lives* in uberblick, not a change of technology. Yjs, Hocuspocus, SQLite, the block model and the MCP tool surface all stay. The claim is that the product's scaling and offline problems come from one rule — every MCP process holds and subscribes to the whole corpus — and from the browser holding a second, unindexed copy, and that both are fixed by making the *machine* the unit of local-first, with one shared store, and by making the *hub* an application server that derives indexes from the documents it already stores.

Challengers: hunt for counterexamples, missing failure paths, wrong assumptions, over-engineering, and anything the plan promises that the evidence does not support. Section 11 lists the claims I consider weakest. Do not soften findings to be polite; do not pad with praise.

## 1. Context

**Product goal (Product Overview, corpus).** A self-hosted, open-source knowledge base for teams of roughly 50–100 people. Agents are primary readers and writers through MCP; humans read and write through a web editor. Knowledge must survive sessions, state must be honest, and the owner stays in control of consequential choices.

**Where the code is (Architecture, corpus; `origin/main`).** One Yjs document per uberblick document, four fixed roots (`meta`, `blocks`, `annotations`, `decisions`). One Hocuspocus hub pinned to 4.6.0 with SQLite persistence: one snapshot row per document, no history, no attribution. An MCP server per agent session, each holding an authoritative local replica: an append-only update log in SQLite (one file per machine and workspace, shared by every process on that machine), plus a derived FTS5/tags/links index. Every MCP process eagerly attaches every room in the workspace. The web client is Tiptap + y-prosemirror with a y-indexeddb cache per room, and has no search index of its own. Workspace-level documents (`_directory`, `_sidebar`, `_feedback`) are themselves Yjs documents replicated to everyone.

**Release 1 (2026-08-27)** decided the plain star (topology end-state B) with the per-machine shape parked behind evidence triggers, and recorded a "pre-fork package" and a non-serving sidecar as the shared intermediate step (Topology decision parameters; Deferred designs and their triggers, §2).

**The daemon spike (#704, PR #719, 2026-09-02)** tested a daemon that solely owned SQLite and the hub socket, with real `ub mcp serve` processes proxied over a Unix socket and the unmodified web app bridged through a loopback Hocuspocus ingress. It proved the content and identity path and met its steady-state bars, and reported two hard stops. My reading of its harness (see §8) is that both hard stops are undiagnosed artifacts of that cut, not properties of a per-machine topology.

**Why now.** The product is pre-launch. The owner wants to step back once, before strangers self-host, and decide the shape deliberately instead of accreting it.

## 2. Required and preferred product properties (owner, 2026-09-02)

Stated so a reviewer can weigh every option against them. They describe what the product must or should do, not how. A challenger who can satisfy them with a different shape than §5 should say so; that counts as a finding, not as a deviation.

**Strongly required**

- **R1 — Complete offline operation on one machine.** With no hub reachable, a person edits in the browser, agents on that machine read, search and write through MCP, and the two see each other's work. Listing and searching the corpus in the browser must work offline too. Agents on local models (Ollama-class) are a real and growing case.
- **R2 — Start local, elevate later.** A workspace starts on one machine with no infrastructure and is later elevated to a hub on a remote machine when a team forms, without re-creating anything.
- **R3 — Teams of fifty to a hundred people sync through one hub without ceremony.**
- **R4 — Agents sync without a person present.** Corpus work happens unattended on remote machines, so an MCP process must be able to push and pull on its own.
- **R5 — Users and per-document permissions come later**, and nothing decided now may make them impossible.

**Strongly preferred**

- **P1 — A machine's work stays on the machine.** The main case is several MCP processes at once whose back-and-forth with a local agent should not accumulate network latency across a sequence of tool calls. A single round trip is not the concern; the sequence is.
- **P2 — Load lives on the well-equipped developer machines** rather than being centralized on the hub by default.
- **P3 — Keep the current technology** (Yjs, Hocuspocus, SQLite) and use it more deliberately rather than switching engines. A switch needs a reason the current stack cannot meet.
- **P4 — No installed daemon or service manager on a person's machine.** A foreground process started when the person sits down is acceptable.
- **P5 — Revoked data is eventually removed from a machine.** Deferred: a boundary to record, not to build now.

## 3. What stays (not up for re-decision here)

- Yjs for merge: block text, marks, annotations, per-document metadata. One `yjs` module per process. One update encoding (v1) everywhere.
- Hocuspocus 4.6.0, pinned, with its four recorded obligations (Architecture, decision records).
- SQLite as the engine on both sides. WAL. FTS5.
- The block model (closed set of seven types, flat), the room grammar (`<workspaceId>/<docUuid>`), UUID identity, markdown as export only.
- The MCP tool surface and its honesty contract (`{applied, synced}`, `rev`, block-scoped edits, no whole-document write).
- The CLI shape (`ub init | open | status | doctor | remote | mcp`).

Rejected alternatives, recorded so they are not re-proposed: CouchDB/PouchDB (document-level winner-picks-conflict; cannot merge text; a second sync system beside Yjs; heavier to self-host); Automerge (same class as Yjs, a rewrite for no gain); Postgres-centric sync engines (ElectricSQL, PowerSync, Zero: server-authoritative, Postgres as a runtime dependency, not built for CRDT text).

## 4. Options weighed

| # | Option | Shape | Verdict |
|---|---|---|---|
| A | Full corpus per process (today) | Every MCP process loads every document and subscribes to every room; the browser keeps a second full copy in IndexedDB with no index | **Rejected.** Subscriptions scale with people × processes × documents; completeness, ceilings and presence need machinery of their own; the browser copy answers no search. |
| B | Thin clients | The MCP server and the browser are plain Yjs clients of the hub; the hub owns every index | **Rejected.** Fails R1 and R2; works against P1 and P2. |
| C | Daemon owning the store | One daemon is the sole owner of SQLite and the hub socket; MCP processes reach it through a socket proxy (the #704 cut) | **Rejected.** The proxy layer and a second publication path produced what the spike observed; heavier than the problem. |
| D | One store per machine as a bus | Every local process uses the store directly; `ub open` serves the browser and syncs upstream; the hub derives indexes and answers over HTTP | **Proposed.** |

## 5. Target shape (option D)

### 5.1 On a machine

**Vocabulary.** *Machine*: one computer running one person's processes. *Store*: that machine's single SQLite file per workspace — the append-only update log plus the derived index. *Serving process*: what `ub open` runs. *Lease*: the store-held right to maintain the index and run catch-up, held by one process at a time. *Catch-up*: pulling every change since a watermark.

- **The store is the bus.** Every local process appends its Yjs updates to the shared log and replays the log tail before answering — the store's contract today (`store.ts`: "two instances sharing one database is the normal case"; WAL; `busy_timeout = 5000`; `seq` is commit order). MCP processes read and write without leaving the machine. Nothing is proxied; no process owns another.
- **Lazy attach.** A process attaches a room only while a tool call reads or edits that document and detaches after an idle window (the existing 30-second presence rule is the natural one). It no longer holds an in-memory replica of every document, and no longer subscribes to every room.
- **The lease.** One process at a time maintains the derived index and runs catch-up. Everyone else reads the index. When nobody holds the lease, MCP processes still sync the documents they touch (R4) and the index is honestly "as of" its last maintenance.
- **`ub open` is the serving process.** Foreground, started when a person sits down. It: serves the web bundle; runs an in-process Hocuspocus server (the pinned hub code) for localhost rooms; answers list and search over HTTP from the store's index; relays other processes' writes to the browser by tailing the log; syncs the workspace with the remote hub (taking the lease when it runs); exposes a status endpoint with both readings of "synced". **No daemon, no service manager** (owner decision, 2026-09-02).
- **MCP processes keep their own hub path.** They sync the documents they touch directly with the hub whenever no serving process holds the lease. Two paths stay; the hub does not care which one an update arrives on; Yjs merges.
- **The browser is thin.** Working locally it talks only to localhost; the store is the only local copy; y-indexeddb is removed. A browser opened against the remote hub from a machine without `ub` keeps today's direct connection and works while connected (not offline; R1 is met by the local mode).

### 5.2 Between a machine and the hub

- **Live rooms carry only open documents.** Presence semantics unchanged.
- **Catch-up by pull.** The hub keeps a monotonic change sequence over everything it stores. A machine asks "what changed since my watermark", receives `(docUuid, seq)` pairs, and pulls each changed document's state as a Yjs diff against the state vector it holds, in bulk over HTTP, at its own pace. Applied through the same `applyUpdate` path as room traffic, so the two paths cannot disagree.
- **Cold start and elevation are the same transfer.** A new machine bootstraps the workspace in one request instead of a handshake per room. A workspace that started local is uploaded to a new hub in one request the other way (`ub remote init` then push). This subsumes the banked export/import (#382) — same shape, over HTTP.
- **Two readings of "synced".** The serving process acknowledges to the browser when an update is in the store (applied). Only it knows when the hub acknowledged; it exposes that as a second reading. The status line must show both; one word for both would repeat the durability lie the topology record warned about.
- **Acknowledgement bookkeeping.** The existing rule — `clearPending` may only clear through a sequence the clearing process itself watched be acknowledged — extends to bulk acks. Two upstream paths on the same document are safe for content (Yjs) and must be proven safe for the pending set (§8).

### 5.3 The hub

- **An application server that also relays rooms.** One process, one container; SQLite stays (Postgres for a hosted multi-tenant future is a store swap, not a shape change).
- **Per-document append-only log.** `updates(doc, seq, identity, ts, update)`; the current snapshot is derived and cached. One structure serves catch-up (the sequence), history and attribution (identity + time), and the versions/diffs the roadmap asks for. The hub already knows the sending connection's identity (`context.sub`) on every update and records none of it.
- **Derived tables.** Directory, FTS, tags, links/backlinks, maintained from stored updates (the `onStoreDocument`/`onChange` hooks exist). Answered over an HTTP API that carries an identity — for browsers without a store and for hub-only agents.
- **Structured non-document data** (issue/PR state, agent reports for the dashboard, later users/roles) lives in hub tables, never in Yjs documents.

### 5.4 Workspace-level documents

- `_directory` stops being a shared Yjs document: derived on the hub from each document's own `meta`, derived on a machine from its store. Offline creation is listable locally because the local derivation runs on the local log.
- `_sidebar` stays a small Yjs document (curated order is genuinely collaborative; an unopenable pinned document already renders as `unknown`).
- `_feedback` is cut (banked in Deferred designs §8; filed 2026-09-02 as #725, independent of this plan).
- The `decisions` root and per-document `meta` are unchanged.

## 6. Mechanisms in detail (design sketches, not commitments)

**Log-tail relay in the serving process.** Poll the store for `seq > lastSeen` every ~100 ms, or cheaper: check `PRAGMA data_version` (changes whenever another connection commits) and only then read the tail. Apply with `LOG_ORIGIN` so the observer does not re-log; relay to browser rooms via the in-process Hocuspocus server. Target: MCP write visible in the browser well under 250 ms. Measured in the store spike.

**Lease.** A `lease(name PRIMARY KEY, holder TEXT, expires_at INTEGER)` row. Acquire: `INSERT … ON CONFLICT(name) DO UPDATE SET holder=?, expires_at=? WHERE expires_at < now`. Renew every 5 s with a 15 s TTL; a holder that misses renewal loses it; SQLite's single-writer transaction is the arbiter, so no clock agreement beyond one machine is needed. Index maintenance and catch-up run only while held. Priority: the serving process takes the lease when it starts; an MCP process takes it only if it is free.

**Index freshness.** The store records `index_watermark` (the highest log `seq` the index reflects). `search`/`list_docs` answers carry `asOf`; the web status line shows it when it lags.

**Catch-up protocol (hub HTTP, identity-carrying).**
- `GET /api/changes?since=<seq>` → `{ seq, changes: [{doc, seq}] }` (filtered by what the identity may read; a permission change re-lists the affected documents at a new seq).
- `GET /api/docs/<uuid>/state?sv=<base64 state vector>` → Yjs v1 diff update.
- `POST /api/docs/<uuid>/updates` → bulk upload; the hub answers the sequence it assigned (the ack).
- `GET /api/bootstrap` → streamed `(doc, state)` for every visible document.
- `GET /api/search?q=` , `GET /api/directory` → derived tables.

**Room lifecycle on a machine.** Attach on the first tool call touching a document; detach after the idle window; the serving process attaches localhost rooms on browser demand and upstream rooms for documents the browser or an MCP process has open.

**Two-level status.** The store's `pending_rooms` table already holds the applied-but-unacked set. The serving process publishes `/api/status` = `{hub: connected|down|auth-failed|update-required, rooms: {room: {applied, hubAcked}}}`; the browser renders "saved here" and "synced with hub" as two facts.

**Elevation.** `ub remote init <target>` (exists) then `ub remote push`: bulk upload of the local workspace to the new hub; the local store's watermark becomes the hub's sequence. `ub remote join` on a second machine = bootstrap.

**Versioning.** `PRAGMA user_version` on both stores with ordered migrations; a `shape` integer in `meta` per document; the rule "an older client preserves what it does not understand and never rewrites it" made explicit and tested (the schema package's existing "unknown root preserved" behaviour generalized to unknown block attributes and marks).

## 7. Rules banked for later requirements

**Permissions.** Unit = the document (a room; checked in one place). Three rules: (1) the hub filters before it sends — rooms, changes, bootstrap, search take an identity and return only what it may read (today: everything); (2) nothing workspace-wide may leak per-document facts — hence the derived, per-identity directory; (3) a local copy cannot be taken back — revocation stops future sync and writes; removal from the machine is a later requirement of its own.

**Binary assets.** Never in Yjs. A hub starts without them; an operator-configured S3-compatible bucket enables them. A block references an asset by id; the hub stores/serves; machines cache; an asset's permission follows the referencing document.

**Growth.** Yjs documents carry their whole history and nothing compacts it. The hub log makes a snapshot-and-new-epoch scheme possible without losing history; decide the scheme when real use shows the size (expect within a year of team use).

**Deletion.** Archive supersedes deletion; an append-only hub log makes true deletion a history rewrite. Write down what is promised before launch.

**Launch ends the flag-day licence.** Protocol version exists; storage versions and document-shape version are added before launch.

## 8. Evidence and proofs

**Reading of #704 / PR #719.** Proven: one process served the real web app and two real `ub mcp serve` processes with distinct presence; steady-state edit latency, idle RSS, reconnect and propagation met their bars; a synchronously appended edit survived a crash before its reply. Not established: (a) "upstream outage erased pre-outage content" — the driver read only `blocks[0]` at every step, and the browser was already in `syncing…` before the test typed, so a displaced new block and an erased document are indistinguishable in its evidence; (b) "a refused append propagated" — production quarantines the upstream provider before the Hocuspocus listener runs (`replica.ts:493-530`), but the daemon's browser bridge was a second, un-quarantined outlet, so the browser held the refused edit and pushed it back after restart. Both belong to cut C. The report's own recommendation ("make the daemon's durable local append the only publication point") is consistent with this reading. Cold start missed a provisional bar with credible remedies, which by the issue's own rule is not a hard stop.

**Proof 1 — the shared store (spike issue, staged).** Four processes mostly reading and one reading and writing on one WAL store with the lease in place, on one machine: every committed write visible to the next read of every other process within a declared bound; exactly one lease holder, SIGKILL handoff within a bound with no duplicated or lost index work; `edit_block`/`get_doc` p50/p95 within declared bars relative to a single-process baseline; no `SQLITE_BUSY` escapes; one report, unmerged harness. **The decision is not taken until this passes.**

**Proof 2 — the log-tail relay and two upstream paths (folded into proof 1 or its own issue, adversaries to say).** MCP write → browser visibility latency; the pending set stays correct when the serving process and an MCP process both sync the same document upstream.

**Proof 3 — a load probe at target scale (later, synthetic).** One hub, ~100 simulated machines, lazy attach, catch-up polling, derived index; hub CPU, memory, and catch-up latency.

## 9. Sequencing

**Phase 0 — decide and prove.** Adversarial review of this plan (now). Proof 1. Corpus decision record (short). Revise Topology decision parameters, Deferred designs §2, Architecture (map at main unchanged until code lands), CLAUDE.md decided-architecture section (tier 3, owner approval).

**Phase 1 — the machine.** Lease. Lazy attach + idle detach in the MCP server. `ub open`: in-process localhost rooms, log-tail relay, HTTP list/search from the store, two-level status endpoint; browser served locally with IndexedDB removed. Local derived directory from the store.

**Phase 2 — the hub.** Per-document append-only log with identity (with the snapshot cache); change sequence; changes/state/bootstrap/upload endpoints; derived directory/search/tags/links + HTTP search; `_directory` retired; `_feedback` cut (#725, may land earlier).

**Phase 3 — journeys.** Start local → elevate (`ub remote push`). New machine cold start via bootstrap. Offline machine: browser + two MCP processes + local agent, review in Uberblick, reconnect converges. Proof 3.

**Phase 4 — launch hygiene.** Storage and shape versions; deletion promise; version-skew message; update REMOTE.md and the corpus.

Rough size: phases 1–2 are each 5–8 issues; the whole re-cut is a program, not a sprint.

## 10. Risks and open questions

- **SQLite multi-process only on a local filesystem.** Network filesystems break WAL locking; the store must refuse them. macOS sleep/wake and file-lock behaviour need one deliberate test.
- **Lease under a stuck holder.** A process alive but wedged renews the lease and does no work; add a progress check (index watermark must advance while the log grows) or the lease is worthless.
- **Serving process dies mid-relay.** Browser edits are in the store before the ack, so nothing is lost; the browser must show "not saved" rather than "synced" while the process is gone (today's departure handling covers the socket; the two-level status must cover the ack).
- **Catch-up completeness.** Sequence gaps, archives/tombstones, permission changes, and documents deleted or re-keyed must all appear in `/api/changes`; a client that misses one change is silently stale forever. This is the CouchDB `_changes` problem and must be specified, not improvised.
- **Two upstream paths racing on one document.** Content is safe (Yjs). The pending set and the watermark are not obviously safe — proof 2.
- **Second origin.** A browser at localhost and a browser at the hub are two origins; the status line must name the endpoint (the endpoint-confusion incident, #376/#385).
- **Hocuspocus inside `ub open`.** Pinned-server obligations apply to the local instance too; the seams test must cover it.
- **Store layout change pre-launch** is still under the flag-day licence; after launch it is a migration.
- **What "visible set" means before permissions exist** — today everything; the filter function exists from day one and returns all.
- **Windows** is untested throughout.
- **Over-engineering watch.** The bulk endpoints, the lease and the derived hub tables are each justified by a requirement in §2; if an adversary can meet the same requirement with less, that wins.

## 11. Claims I consider weakest (attack these first)

1. That the store-as-bus with a log-tail relay is fast and correct enough for the browser without a daemon owning the documents in memory.
2. That the lease is sufficient coordination — no split-brain index, no duplicated catch-up, sane behaviour when nobody holds it.
3. That catch-up by pull can be made complete (tombstones, permission changes, gaps) with a single hub sequence.
4. That two upstream paths (serving process + MCP direct) keep the pending set and "synced" honest.
5. That my reading of #704's hard stops is right — that they are artifacts of cut C, not of any per-machine shape.
6. That removing IndexedDB loses nothing the §2 requirements need.
7. That the hub as application server does not reintroduce the server-authoritative latency the topology record rejects (it should not: a machine with a store never asks the hub for reads).
8. That per-document metadata can stay in Yjs while the directory becomes derived, without a consistency gap between the two on a machine.
9. That this is not over-engineered relative to the §2 requirements; that phases 1 and 2 are the smallest cut that meets them.

## 12. Records this changes

- Topology decision parameters (`8d148677-93cc-4e7a-953f-67c65b77598f`): end-state B → end-state A's shape with the store (not a daemon) as the machine's authority; the "hub-side index violates the local anchor" line narrowed to lazy attachment breaking local search.
- Deferred designs and their triggers (`435d453a-5bf2-46aa-b84a-e14959133032`) §2: the sidecar and active-document model subsumed by the lease and the open-document rule; §8 `_feedback` cut executes.
- Architecture (`d2d28f20-7c9a-4547-b65b-0fdf75a41dff`): rewritten as code lands.
- CLAUDE.md, "Architecture (decided)" and "Invariants": eager full-corpus attach, IndexedDB, the directory as a synced doc, and "the MCP server hydrates from its log never the hub" (still true; bootstrap is a hydration *source* for an empty store, and the log remains authoritative once written — wording to revise).
- Open issue #704 closes with PR #719's report merged; #719's verdict is annotated with the reading in §8 (comment, not a rewrite).

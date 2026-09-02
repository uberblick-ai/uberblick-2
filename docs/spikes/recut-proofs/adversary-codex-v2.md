# Read-only delivery instruction

> the previous Codex run in this workspace could not write its verdict because the read-only sandbox blocks all file writes, even to the scratch directory. Therefore Codex must NOT try to write any file; it must deliver the complete verdict as the FULL TEXT OF ITS FINAL MESSAGE, in markdown, and nothing else in that final message. Include that instruction verbatim and prominently.

## 1. Verdict

V2 does not yet survive as the basis for a provisional decision. Its most serious remaining problem is the false claim that today’s `ub remote join` satisfies R2: the command can report a successful elevation while deliberately leaving every non-pending archived document’s body on the old machine, so retiring or losing that machine can turn a supposedly restorable archive into an empty tombstone. I reviewed repository HEAD `f0af6ae`, the seven requested corpus records through the configured Uberblick MCP, and the locally present spike ref at the report’s exact artifact `9451ad4`; I did not run `git fetch` because it writes `FETCH_HEAD` and objects. Live `gh issue view 704` and `gh pr view 719` were unavailable because network access failed, so GitHub claims below are limited to the locally available branch and report at `8ab4693`.

## 2. Findings

### 1. Elevation declares success without moving archived document bodies

**Severity:** P1  
**Status:** CONFIRMED

**Claim attacked:** §5.5: “R2 is met today by `ub remote join` … a workspace that started local is uploaded by the first join.”

**Counterexample and evidence:** The bridge explicitly says, “Neither function moves a tombstoned document”; only its directory tombstone travels ([remote.ts:51](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/remote.ts:51)). It opens only live rooms ([remote.ts:404](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/remote.ts:404)), represents a tombstone with `fingerprint: null` and `stateVector: null`, and therefore never verifies archived content. The CLI even reports that archived content was not moved ([remote.ts:603](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/cli/src/remote.ts:603)). `adoptKnownDocs` skips tombstoned rooms unless they remain pending ([replica.ts:939](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/replica.ts:939)). A document whose updates were previously acknowledged by the local hub is no longer pending. Archive it, join an empty remote hub, accept the successful verification, and retire the old machine: the remote has the tombstone but not the room. Restoring it produces a known-but-unhydrated document, contradicting the MCP archive contract that blocks and annotations remain readable and restorable ([tools.ts:1422](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/tools.ts:1422); *MCP interface contract*, “Archive and restore”; *CLI user experiences*, blocks 5, 8, 12, 17).

**Smallest change:** Withdraw the R2 claim until `ub remote join` attaches, uploads, and fresh-client-verifies every archived room as well as every live room. Keep the tombstone in `_directory`; compare archived room state vectors/content separately. No bulk protocol is required.

### 2. V2 dropped the only browser full-text search path while keeping browser search in R1

**Severity:** P1  
**Status:** CONFIRMED

**Claim attacked:** R1: “Listing and searching the corpus in the browser works offline too.”

**Counterexample and evidence:** V2’s `ub open` surface names bundle serving, local Hocuspocus, relay, presence, and `/api/status`, but no search endpoint or UI (§5.3). The current browser filters only lower-cased titles from directory stubs and explicitly excludes descriptions and document bodies ([DocumentList.tsx:17](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/web/src/shell/DocumentList.tsx:17)). Full-text search exists only as an MCP tool over the local FTS5 index ([tools.ts:1100](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/tools.ts:1100)). V2 itself describes the current web client as having “no search of its own,” so its title filter is not the required search. V1 had the necessary local-only mechanism—`ub open` answering list/search over HTTP—and V2 silently lost it (`v1-local-first-per-machine.md`, §5.1 line 76 and phase 1 line 151).

**Smallest change:** Restore only the local part of v1: a token-gated, CORS-less `/api/search` over the shared `MirrorStore`, plus a browser full-text search surface. Require the endpoint to catch the index up before answering. Do not restore hub-side search.

### 3. The gate is viable only through the prehook, and that prehook can durably poison the log

**Severity:** P1  
**Status:** CONFIRMED

**Claim attacked:** §5.3: use either “the awaited pre-apply hook (`beforeHandleMessage`), decoding the sync frame and appending the update” or “a synchronous `update` listener registered ahead of the server’s own.”

**Counterexample and evidence:** The good part is verified: `Connection.processMessages` awaits `beforeHandleMessage` before `MessageReceiver.apply` (`@hocuspocus/server/src/Connection.ts:252-275`), while sync step 2 and update branches apply the Yjs payload and only then send `SyncStatus(true)` (`MessageReceiver.ts:216-280`). An unpatched durable-before-apply/ack gate is therefore possible.

The second mechanism is not possible through the pinned server’s public lifecycle. `Document` registers its own Yjs `update` listener in its constructor (`Document.ts:74-90`). The host receives the constructed document only in `onLoadDocument`, after construction (`Hocuspocus.ts:385-429`). The server’s listener runs `onUpdate` and schedules/broadcasts at `Document.ts:332-354`; any host listener registered afterward cannot run ahead of it.

The viable prehook still has an unaddressed poison path. It must append before the server parses and applies the Yjs payload. A malformed update such as `Uint8Array([0xff])` was rejected by the pinned Yjs with `Unexpected end of array` in a read-only in-memory probe, but under the proposed order those bytes have already been committed. Current hydration applies every stored update without a catch ([replica.ts:563](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/replica.ts:563)), so one malformed authorized frame can make that room fail on every restart. The plan also does not say how the later `Document` observer recognizes that the connection-origin update was already logged; the current observer logs every non-`LOG_ORIGIN` update ([replica.ts:493](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/replica.ts:493)).

**Smallest change:** Delete the listener alternative. Specify one prehook mechanism that decodes the outer and inner sync opcodes, ignores step 1/awareness/read-only writes, validates the Yjs payload against a scratch document before append, and marks the ensuing connection-origin application as already logged while still allowing indexing. Proof 1b must include malformed frames, read-only frames, duplicate-log detection, refusal, broadcast, upstream forwarding, and ack order.

### 4. Fencing a background index writer does not stop it overwriting newer rows with older state

**Severity:** P1  
**Status:** CONFIRMED

**Claim attacked:** §5.2: “Every writer indexes what it changes … `search` and `list_docs` therefore never lag a local write,” with generation fencing for background index rows.

**Counterexample and evidence:** The index has no source sequence or causal watermark in its schema ([store.ts:178](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/store.ts:178)). Every index operation unconditionally upserts metadata, deletes all tags/links/FTS rows, and inserts replacements ([store.ts:408](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/store.ts:408), [store.ts:500](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/store.ts:500)). A holder can derive rows from a document at log cut N, be descheduled, then commit after a follower has appended N+1 and indexed the newer document. The holder still has a valid lease generation, so fencing accepts its stale replacement. The same race exists between two concurrent writers that each settled before the other’s append. Search may then remain stale indefinitely until another update or rebuild. V1 at least named an `index_watermark`; V2 removed it without replacing its ordering function.

**Smallest change:** An index writer must capture a room-log cut, replay every update through that cut, and commit rows only in a transaction that verifies no newer room update exists and that no newer index cut is already stored. Record an `indexed_through_seq` per document; order tombstone/unindex work against the directory update sequence as well. Search must catch up or retry when the index cut trails the relevant store head.

### 5. Removing IndexedDB creates an unbounded disconnected-session loss window, not the stated send-to-gate window

**Severity:** P1  
**Status:** CONFIRMED

**Claim attacked:** §5.4: “an edit typed after the browser sent it and before the gate stored it is lost if `ub open` dies in that window.”

**Counterexample and evidence:** When the socket disconnects, the current UI updates status but does not disable editing; editability depends only on archive state ([rooms.ts:495](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/web/src/collab/rooms.ts:495), [EditorPane.tsx:428](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/web/src/ui/EditorPane.tsx:428), [EditorPane.tsx:530](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/web/src/ui/EditorPane.tsx:530)). A person can continue editing the in-memory Y.Doc for minutes or hours while `ub open` is absent. Reloading or losing the tab then drops the entire disconnected session. Current IndexedDB is exactly the durable buffer for that state ([rooms.ts:547](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/web/src/collab/rooms.ts:547)). This finding does not reverse the owner’s decision to remove IndexedDB; it falsifies V2’s stated size of the accepted loss.

**Smallest change:** State the real loss boundary. Either make the local editor read-only immediately when the localhost connection disappears, or explicitly accept loss of every edit made during an arbitrarily long disconnected session. Proof 1b must exercise continued typing, socket backpressure, `ub open` death, tab crash, and reload—not only death between send and append.

### 6. HocuspocusProvider has no awareness-only mode, and two allowed serving processes split offline presence

**Severity:** P2  
**Status:** CONFIRMED

**Claim attacked:** §5.3: “MCP processes open one localhost provider per touched room to `ub open`, carrying awareness only,” combined with §5.3’s allowance for two `ub open`s on one store.

**Counterexample and evidence:** `HocuspocusProvider` always registers a document-update listener (`provider/src/HocuspocusProvider.ts:212-250`) and sends every non-provider-origin document update (`HocuspocusProvider.ts:398-405`). Passing the MCP replica’s real Y.Doc therefore creates the content path V2 says does not exist. An awareness-only use requires an explicitly separate throwaway Y.Doc or a different transport; neither is specified.

Presence is not in the SQLite log. With the hub unavailable, two `ub open` processes have two independent server Awareness instances. A browser connected to A cannot see an MCP provider connected to B. The plan does not define endpoint discovery or fan-out between them, contradicting the invariant that every client publishes awareness and agent sessions are visible in the UI ([CLAUDE.md:279](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/CLAUDE.md:279)).

**Smallest change:** Permit only one serving process per identity/store, independently of which process holds the full-corpus lease. Use a provider bound to a throwaway Y.Doc for awareness, and add a seam test proving no authoritative document update is sent or applied through it. If multiple serving processes remain, V2 needs a single discovered presence authority; the SQLite content log cannot supply it.

### 7. Follower content providers are redundant and create Proof 2’s entire correctness problem

**Severity:** P2  
**Status:** CONFIRMED

**Claim attacked:** §5.2: “Followers keep their own hub path,” even though the holder “attaches every room, pushes every pending room and runs background catch-up.”

**Counterexample and evidence:** Under V2’s own contract, every active store has one renewing holder, every local write is durable in the shared log, and the holder polls and pushes the whole corpus. A follower content provider adds no required capability: if the holder dies, the write remains local until the 15-second lease expires and the next process takes over. Its added effects are more hub subscriptions, overlapping sends, process-local acknowledgement state, and the shared pending-set race that requires Proof 2. Current clearing already has to cap acknowledgements by the clearing replica’s own applied sequence ([replica.ts:1121](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/replica.ts:1121)); adding a second sender is not free because Yjs idempotence covers content, not acknowledgement bookkeeping.

**Smallest change:** Make the holder the only upstream content publisher for a store. Followers append and replay locally; their mutating calls may honestly return `synced: false` until the holder clears the pending marker. Preserve separate awareness-only connections where session presence needs to reach a remote browser. Delete Proof 2 and its two-sender implementation.

### 8. “Stop everything, upgrade, start” is not an enforceable schema-version protocol

**Severity:** P2  
**Status:** PLAUSIBLE

**Claim attacked:** §7: “a process refuses a store whose schema version is newer than its own, so an upgrade is ordered ‘stop everything, upgrade, start’ and never mixed.”

**Counterexample and evidence:** MCP servers are independent child processes launched by external clients ([serve.ts:39](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/cli/src/serve.ts:39)). A store handle and its prepared statements remain open for that process’s lifetime ([store.ts:328](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/store.ts:328)). An old process that opened before migration does not discover that the schema later became newer merely because new opens check a version row. It can resume and execute old prepared writes after the migration. There is no daemon or supervisor to prove “everything” stopped.

**Smallest change:** Either delete schema migration from this pre-release flag-day cut, or specify a protocol established in the first shared-store version: every write checks schema generation in its transaction, processes register/renew their binary version, and migration refuses while an incompatible live registration exists. An open-time check alone is insufficient.

### 9. The store does not record authorship or session origin

**Severity:** P3  
**Status:** CONFIRMED

**Claim attacked:** §8: history’s doors stay open partly because “the store already records origin per update.”

**Counterexample and evidence:** `UpdateOrigin` is only `"local" | "remote"` ([store.ts:53](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/store.ts:53)); the update table stores that diagnostic value, payload, and timestamp, but no identity, session, or Yjs-client mapping ([store.ts:149](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/store.ts:149)). The topology does preserve Yjs client IDs inside update payloads, but session-level blame is recoverable only if a durable `(identity, session, clientID)` registration exists before the session disappears. Deferring history is the owner’s decision; citing `origin` as evidence that its dependency is preserved is still false.

**Smallest change:** Replace the sentence with the actual dependency: D2 preserves Yjs client IDs and per-user store separation, while the future history design must durably register client IDs before their first attributable update; updates predating that facility are not retrospectively attributable.

## 3. V2 §11 claim matrix

| # | Claim | Verdict | Reason |
|---:|---|---|---|
| 1 | Gate works without patching and avoids an unacceptable browser stall | **Weakened** | The awaited prehook works unpatched; the listener alternative is impossible, and pre-validation/deduplication are missing. The synchronous busy-timeout stall remains. |
| 2 | Fenced holder plus lazy followers is enough for R3 and handoff | **Weakened** | Fencing establishes role ownership, not causal index freshness. Handoff and hub capacity remain probe questions. |
| 3 | Awareness-only localhost provider is sufficient | **Falsified** | The standard provider always syncs document updates, and two permitted serving processes form separate offline awareness islands. |
| 4 | Two upstream paths keep pending state honest | **Weakened** | Proof 2 is now mandatory, but the property is still unproved and the second content path is unnecessary. |
| 5 | IndexedDB removal has the stated acceptable crash window | **Falsified** | The window can encompass the entire disconnected editing session, not merely send-to-gate latency. |
| 6 | Current `ub remote join` meets R2, including large workspaces | **Falsified** | It deliberately omits archived bodies; its bounded, 32-at-a-time room hydration also leaves the “thousands” part unmeasured. |
| 7 | An unchanged hub can serve 50–100 holders | **Weakened** | Plausible but unevidenced; full-corpus holder subscriptions still scale as identities × documents. The owner’s scale probe correctly informs rather than gates. |
| 8 | D2 is the smallest cut and lost nothing necessary from v1 | **Falsified** | It lost v1’s local browser search and index watermark while retaining redundant follower content paths and their proof burden. |
| 9 | Separating history/dashboard hides no topology dependency | **Weakened** | Dashboard separation holds; history still needs durable client-ID registration, and the cited store `origin` is not attribution. |

## 4. Wrong or incomplete v1 dispositions

- **Fable F1 / Codex 1:** Incomplete. The prehook resolves ordering, but the alternative listener cannot; validation, read-only handling, and duplicate-log suppression remain unspecified.
- **Fable F2:** Incomplete. “Awareness-only provider” is not a provider configuration, and two allowed `ub open`s split offline awareness.
- **Fable F11 / Codex 3:** Incomplete. Hub machinery was removed, but v1’s required local browser-search path was removed with it.
- **Fable F12:** Incomplete. Its token-gated `/api/search` requirement was not carried into §5.3.
- **Codex 4:** Incomplete. Letting every writer index removes lease-only staleness but not stale-writer overwrite; a causal index cut is still absent.
- **Codex 5:** Wrong. Removing bulk transfer does not establish R2; current join verifies tombstones while omitting their document rooms.
- **Codex 7 / Fable F12:** Incomplete. The owner accepted removal, but V2 understates the loss window as a narrow send-to-append interval.
- **Fable F6 / Codex 9:** Incomplete. Moving history out is valid, but `local|remote` origin is not authorship and preserves no session mapping.
- **Codex 10:** Formally accepted but overbuilt. Making Proof 2 mandatory retains a correctness dependency that a holder-only content path deletes.

## 5. Over-engineering check against R1–R5 and P1–P6

| Property | V2 assessment and simpler alternative |
|---|---|
| **R1** | Local Hocuspocus, the durable gate, relay, and local presence are necessary. Add one local `/api/search`; do not restore hub search. |
| **R2** | Reusing `ub remote join` is the simpler shape, but it must transfer archived rooms. No phase-2 bulk protocol is needed to repair that contract. |
| **R3** | One full-corpus holder per identity is a reasonable hypothesis for the scale probe. Direct follower content subscriptions work against it; remove them. |
| **R4** | A renewing holder that polls and pushes the shared pending set is sufficient. Followers need local durability, not their own content socket. |
| **R5** | One store per eventual user identity keeps the permissions door open. Do not add attribution machinery here, but record the future client-ID-registration dependency honestly. |
| **P1** | Shared WAL reads/writes keep tool sequences local. The synchronous gate may block the event loop for the five-second busy timeout; measure it as planned before adding a queue. |
| **P2** | Holder-side indexing and sync keep computation on developer machines. Follower content providers add hub load without moving useful computation. |
| **P3** | D2 stays within Yjs, Hocuspocus, and SQLite. A throwaway provider document is sufficient for awareness; no new transport dependency is justified yet. |
| **P4** | Foreground `ub open` fits. Allowing multiple serving processes per store adds presence discovery and status reconciliation; refuse the second one instead. |
| **P5** | Remove speculative machinery: the second content path, Proof 2, and the “wedged watermark” heuristic. A true event-loop wedge already stops renewal and expires the TTL. Current compaction is monotonic and transactionally safe ([store.ts:467](/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server/src/store.ts:467)); it does not need fencing for data safety. |
| **P6** | Correctly deferred. Phase 1 should record which store/identity owns a copy, but should not build revocation deletion before permissions exist. |

## 6. Missing entirely

- A complete elevation/read-back contract for archived document rooms.
- A browser full-text search endpoint, UI, and index-freshness boundary.
- A causal, per-document index commit rule that prevents stale replacement.
- The exact prehook decoder/validator/deduplicator and a real awareness-only provider construction.
- An enforceable live-process schema-upgrade barrier and single-serving-process lifecycle.

Codex session ID: 01a06390-8351-7f20-8629-055a1d5fead5
Resume in Codex: codex resume 01a06390-8351-7f20-8629-055a1d5fead5

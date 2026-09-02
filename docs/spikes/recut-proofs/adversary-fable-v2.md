# Adversary verdict — v2 "Local-first per identity" (Fable 5.1, 2026-09-02)

Grounded in `origin/main` `f0af6ae` (worktree; `origin/main` has since moved to `360223e`, which merged PR #719 as `8ab4693`), the corpus records v2 cites (Architecture, Sync topology, Topology decision parameters, Deferred designs, MCP interface contract, CLI interface contract, CLI user experiences), the spike harness at `9451ad4` (`daemon-authority-daemon.ts`, `daemon-authority-spike.ts`) and the merged report `docs/spikes/704-daemon-authority.md`, Hocuspocus 4.6.0 server and provider sources, Yjs 13.6.32 and y-protocols 1.0.7 sources, `gh issue view 704` / `gh pr view 719`, and one loopback probe in my scratch directory (`adversary-fable-v2/gate-probe.mjs`, output in `gate-probe.out`; two runs, identical results). Line numbers are from those files.

## 1. Verdict

v2 survives as a basis for a **provisional** decision: the instinct (one store per identity, one full-corpus holder, `ub open` as a gated localhost ingress, hub untouched) is coherent, the pending set stays honest under two upstream paths by construction, and the gate it depends on is buildable on the pinned server without a patch — but only through one of the two mechanisms v2 offers, and not the one it names first. The single most serious remaining problem is that the smaller cut **does not meet R1**: v2 dropped v1's local HTTP search along with the hub search, so a browser working offline against `ub open` can list the corpus but cannot search it, and today's browser has no search of its own to fall back on. Behind that, the probe falsifies v2's second gate option outright (the refused update is acknowledged, broadcast, and the server document then stops relaying anything for the rest of its life), and about a third of the machine-side machinery (lease fencing, the wedged-holder rule, holder-only compaction, the "awareness-only" provider) is fail-safe work for hazards the store already handles — exactly what P5 says not to build.

## 2. Findings

### F1 — P1 — The cut lost R1's browser search — CONFIRMED

**Claim attacked.** §0 "check whether the smaller cut still meets every required property in §2"; R1 "Listing and searching the corpus in the browser works offline too"; §5.3's list of what `ub open` does (bundle, localhost rooms, gate, relay, presence, two-level status).

**Evidence.** v1 §5.1 had "answers list and search over HTTP from the store's index"; v2 §6 removes "hub search" and §5.3 carries no search surface at all. The web client has none today (v2 §1; `packages/web/src/collab/rooms.ts` opens rooms only; no FTS code exists in `packages/web/src`). §5.2's "`search` and `list_docs` therefore never lag a local write" is about MCP tools. Listing is covered (`_directory` is a localhost room); searching is not. The reconciliation lists "hub-side search for browsers without a store" as possibly lost; the local one went with it.

**Smallest change.** One bullet in §5.3: `ub open` answers search from the store's FTS5 (`store.ts:432-439,659-678`) over the same token-gated localhost HTTP surface as `/api/status`, and one phase-1 issue for the web client to call it. Nothing else in the cut changes.

### F2 — P2 — Only the pre-apply hook is a gate; the `update`-listener option is falsified three ways, and the hook to name is `beforeSync` — CONFIRMED (probe + source)

**Claim attacked.** §5.3 "Two ways to build that on the pinned server, chosen by Proof 1b: the awaited pre-apply hook (`beforeHandleMessage`) … or a synchronous `update` listener registered ahead of the server's own, on the same pattern the MCP replica uses (`replica.ts:493-530`), with the ordering pinned by a seams test"; §11 claim 1.

**Evidence (probe `gate-probe.mjs`, Hocuspocus 4.6.0 server + two providers over loopback).**
- *Throwing `beforeSync`* (`MessageReceiver.ts:189-194`, awaited before `readUpdate`/`readSyncStep2`): sender's `unsyncedChanges` stays 1, `isSynced` false, sender's connection closed with `Reset Connection` (`Connection.ts:287-298`), server text unchanged, peer text unchanged; the next legitimate write from the peer is applied and relayed normally. The hook already receives `{type, payload}` with the update bytes for `messageYjsUpdate` **and** for the reconnect diff (`messageYjsSyncStep2`: seen as type 1, 25 bytes carrying the unsent edit) — so it also gates the reload/reconnect path §5.4 depends on.
- *Throwing `document.on("update")` listener registered in `afterLoadDocument`* (default `flushDelay: 0` and `flushDelay: false` alike): sender receives `SyncStatus(true)` (`unsynced` goes `[1, 0]`, `isSynced` true, no close), the refused text is applied on the server **and reaches the peer**, and after that the server document emits **zero** `update` events for every later write — the peer's next write is applied and acknowledged but never relayed to anyone. Mechanism: y-protocols swallows any throw out of an update observer (`y-protocols/sync.js:82-89`, "Caught error while handling a Yjs update"), so `readSyncMessage` proceeds to the ack (`MessageReceiver.ts:249-255,275-281`); and the throw leaves the stale transaction in `doc._transactionCleanups` (`yjs.mjs:3306-3385`, the `finally` never reaches `_transactionCleanups = []`), after which `finishCleanup` is false for every subsequent transaction (`yjs.mjs:3417-3419`) and no observer, broadcast or `onChange` runs again. This is the hazard `replica.ts:505-510` names, now measured.
- "Registered ahead of the server's own" is impossible without patching: `Document`'s constructor registers `handleUpdate` before any hook can see the document (`Document.ts:89`; `onCreateDocument` runs before construction, `onLoadDocument` after — `Hocuspocus.ts:385-405,419`), and lib0 emits in insertion order (`observable.js:80-83`).
- `beforeHandleMessage` (`Connection.ts:271`) is also pre-apply and also closes the connection on throw, but hands over the raw frame including the address prefix (`ClientConnection.ts:314-329`); `beforeSync` is the decoded, per-sync-type seam and is the one to name.

**Smallest change.** Strike the listener option; name `beforeSync`; add its contract — awaited before apply, throw closes the connection with 4205, y-protocols swallows observer throws — to Obligation 2's seams test (Architecture, decision records), since the whole gate rests on it. Keep the accepted stall (§5.3) as is.

### F3 — P2 — Lease fencing, the wedged-holder rule and holder-only compaction are fail-safes for hazards the store already handles, and the MCP-process holder is under-specified — CONFIRMED

**Claim attacked.** §5.2 "Lease fencing … every holder-only write — compaction, background index rows, the catch-up watermark — runs in a transaction that asserts `lease.holder = me AND lease.generation = mine` … A holder whose watermark does not advance while the log grows is treated as wedged … Only the holder compacts, so followers and the relay never read a log whose rows were pruned under them"; §11 claim 2; P5.

**Evidence.** Each "holder-only write" is already safe against a ghost or a stranger: the snapshot upsert is monotonic (`store.ts:386-394`) and the prune covers only what a surviving snapshot covers (`store.ts:467-481`); `readSince` reads snapshot and tail in one transaction precisely so a concurrent compaction cannot open a gap (`store.ts:483-498`, `replica.ts:549-582`) — today every process compacts and it is safe; index rows are a per-document replace that the next observed update re-derives (`store.ts:500-519`, `replica.ts:609-649`); `clearPending` deletes only `seq <= throughSeq` and can never advance anything (`store.ts:404-406,609-611`); and there is no hub watermark in phase 1. Fencing therefore protects nothing, and "only the holder compacts" buys nothing `readSince` does not already give. Meanwhile the MCP process that v2 says can be the holder ("otherwise the holder is whichever MCP process holds it") runs nothing between tool calls — polling, adoption, release and compaction all live inside `settle()` (`replica.ts:986-1119`); the only timers are cursor and presence withdrawal (`replica.ts:395,1220`). A 5 s renewal needs a timer v2 does not mention, and the wedged rule as written ("watermark does not advance while the log grows") cannot tell an idle-but-healthy MCP holder from a stuck one: an idle holder loses the lease every 15 s, the next process takes it and re-attaches the whole corpus (today's boot cost, `replica.ts:940-974`, in waves of 32, `sync.ts:134`) — lease bounce is the fan-in v2 set out to remove.

**Smallest change.** Reduce the lease to what R3 needs: one advisory row (`name, holder, expires_at`), taken with the conditional update, renewed on a timer, and released in `quarantine()` (`sync.ts:813-826`). No generation, no fenced writes, no wedged rule, every process compacts as today. State that an MCP holder runs a renewal timer and that two processes both believing they hold the lease costs only duplicate attachment for one TTL.

### F4 — P2 — The "awareness-only localhost provider" is not a provider mode that exists, and `_directory` presence is not covered — CONFIRMED

**Claim attacked.** §5.3 "MCP processes open one localhost provider per touched room to `ub open`, carrying awareness only (document updates travel through the store)"; "Workspace-level presence … stays where it is, in the directory room's awareness"; §11 claim 3.

**Evidence.** A `HocuspocusProvider` subscribes to its document's `update` event in its constructor and sends every update whose origin is not itself (`HocuspocusProvider.ts:260,398-417`); there is no awareness-only configuration. Two ways to fake it, both undescribed: (a) pass `replica.doc` and `document.off("update", provider.boundDocumentUpdateHandler)` — but the provider still *receives* the room's updates and applies them to `replica.doc` with the provider as origin, which the log observer classifies as `"local"` (`replica.ts:500-502`, `sync.ts:788-796` knows only hub providers) and appends with a pending mark — every browser keystroke logged again, in every MCP process holding that room, each raising `pending_rooms.seq`; a third origin class in the observer is required; (b) pass a scratch `Y.Doc` (the spike's `SessionPresence` shape, `daemon-authority-daemon.ts:248-257`) — but the server answers the scratch doc's SyncStep1 with the room's full state (`MessageReceiver.ts:197-214`), so each touched room costs a second full copy in the MCP process. Separately, `_directory` is published from attach and never touched by a tool call (`replica.ts:382-385,464-466`), so a per-touched-room localhost provider never carries it: the local browser's "MCP connections" count reads agents only through the hub, and reads 0 offline.

**Smallest change.** Under P5 the smallest cut is no local presence channel at all: agents publish to the hub as today, `ub open` relays hub awareness into the localhost rooms (it must anyway for remote users), and offline there are no agent cursors — which R1's wording ("see each other's work") allows and Deferred designs §2 already recorded as not needed; the owner then re-reads CLAUDE.md's "attributed to a visible agent cursor" criterion as an online one. If local presence is wanted, specify (a) with the third origin class and include `_directory` from boot.

### F5 — P2 — The IndexedDB loss window is misdescribed in kind: after a refusal it is every keystroke until the tab closes — CONFIRMED

**Claim attacked.** §5.4 "an edit typed after the browser sent it and before the gate stored it is lost if `ub open` dies in that window or the page is reloaded then; the browser shows 'not saved' for it"; §11 claim 5.

**Evidence.** The window for a *live* `ub open` is one send (provider sends per update, `HocuspocusProvider.ts:403-406`; a busy-timeout stall widens it to ≤5 s, accepted). But after a *refused* append the pinned client keeps going: the server closes the room (`Connection.ts:292-296`), the web client reads a non-`provider_initiated` close and redials every 2.5–5 s (`rooms.ts:532-545,214-244`), the reconnect diff is refused again (probe, SyncStep2 path), and the editor stays editable — `editable` tracks only the archive flag (`EditorPane.tsx:432`). Everything typed from the refusal until the tab is closed lives in one Y.Doc with no cache. Today that same session survives a reload through y-indexeddb (`rooms.ts:622-636`). The accepted loss is therefore "a session's worth", not "an edit".

**Smallest change.** State it that way, and make the cheapest mitigation part of the gate design: a named close reason on refusal that the web client stops redialling on, and `editable: false` while the room reads "not saved". Proof 1b then measures the window as declared.

### F6 — P2 — Proof 1b omits the one loss actually observed, and Proof 0 discards the evidence that would settle it — CONFIRMED (matrix gap) / PLAUSIBLE (mechanism)

**Claim attacked.** §9 Proof 1b "a refused append is never acknowledged, never broadcast to another tab, never forwarded upstream; page reload after `ub open` death shows exactly the accepted loss of §5.4 and nothing more"; Proof 0 "Re-run the #704 driver reading the full block list and the whole editor".

**Evidence.** The spike's hard stop (a) happened while the *upstream* hub was stopped and the browser typed into a room served by a local ingress with no cache — every ingredient D2 keeps — yet Proof 1b lists refusal and process death only. The driver shows `-hub-down` ended up as `blocks[0]` on its own (`daemon-authority-spike.ts:700-712`), so at typing time the editor was bound to a fragment that had lost its block; the pane refuses to bind an empty document (`App.tsx:200-205`, `route.ts:304-306,325-330`), which points at the daemon side, and the only block-deleting code on that path is `repairDuplicateBlocks` (`schema/src/blocks.ts:438-448`, run on every observed update at `replica.ts:632,843-858`). The decisive instrument already exists and was thrown away: the daemon's append-only log records every update with its origin, and replaying it would name the update that removed the block — but the harness `rmSync`s the database (`daemon-authority-spike.ts:946`).

**Smallest change.** Proof 0 retains the daemon database and replays the room's log per update; Proof 1b adds "upstream hub stopped, browser types, hub restarted" to its matrix.

### F7 — P2 — `ub open` needs a background settle loop and a two-document bridge, and §7 lists neither — CONFIRMED

**Claim attacked.** §5.3 "`ub open` takes the lease … the holder is a full replica"; §7's list of what must be designed.

**Evidence.** Everything a replica does between updates — replay the tail, adopt new rooms, release quiet rooms, compact — runs only inside a tool call's `settle()` (`replica.ts:986-1119,1131-1142,1151-1176`); `ub open` has no tool calls, so the holder role requires a loop driven by `PRAGMA data_version` that v2 describes only for the relay. The relay itself feeds a Hocuspocus `Document`, which is a Y.Doc the server constructs and hydrates by *copying* state (`Hocuspocus.ts:395-405,419-428`) — it cannot adopt the replica's doc — so a served room is two Y.Docs in `ub open`, with document updates crossing through the store and awareness bridged in both directions between `document.awareness` and `replica.awareness` (the spike did one direction, `daemon-authority-daemon.ts:259-266`). Upstream updates arriving on the replica's provider are logged by the replica observer as today; browser updates are logged by the gate; both paths must feed the relay's per-room cursor so `clearPending` (`replica.ts:1131-1142`) can run for browser edits.

**Smallest change.** Add to §7: the background settle loop; the two-doc rule with the awareness bridge; which cursor `releaseQuietRooms` reads in `ub open`.

### F8 — P3 — R2 at thousands of documents is bounded by `ub remote join`'s verification budget, not by the topology — CONFIRMED

**Claim attacked.** §5.5 "R2 is met today by `ub remote join`"; §11 claim 6.

**Evidence.** Join hydrates, then verifies as a fresh client that opens *every* live document (`remote.ts:428-459`), both under `BRIDGE_SYNC_TIMEOUT_MS = 15_000` (`remote.ts:87-110`) and the 32-room admission wave (`sync.ts:134`); a budget miss lands rooms in `unsettled`, `corpusProblem` refuses (`remote.ts:769-776`), and nothing is persisted (`remote.ts:920-940`). At ~2 000 documents that is ~63 waves; at ~5 000 it exceeds the budget on a 50 ms RTT. Elevation (the push) works; the journey becomes "rerun until it fits".

**Smallest change.** Record the bound in §5.5 as a CLI budget (raise it, or verify by directory plus sampled documents) rather than as a hub question for the probe.

### F9 — P3 — Localhost surface details that are seams of the pinned server or contract changes — CONFIRMED

- The Origin check: an `onUpgrade` hook that throws crashes the process (`Server.ts:87-107` rethrows inside an async `upgrade` listener; the hub's own comment at `packages/hub/src/server.ts:512-519`); the spike's `socket.destroy(); return await Promise.reject()` (`daemon-authority-daemon.ts:337-345`) is the only safe idiom and belongs in the seams test with `beforeSync`.
- The served configuration document (`open.ts:678-688`, contract shared with `packages/web/src/config.ts:16-19`) carries one `hubUrl`; under v2 the browser dials the localhost websocket while "synced with hub" must name the remote — a #91 contract change v2 does not list.
- A refused room needs a close reason the client recognises (`rooms.ts:543` checks only `provider_initiated`), or the redial loop in F5 is the default behaviour.
- The store's "refuses a network filesystem" is a detection nobody has written; under P5, document it rather than detect it.

### F10 — P3 — Stale facts in §8/§12 — CONFIRMED

#704 is closed and PR #719 merged (`8ab4693`); the integrator's post-merge pass already wrote the I-F1 caveat into Topology decision parameters ("Candidate spike (#704, merged 2026-09-02) … re-isolate the mechanism"), so "#704 stays open until Proof 0 lands" and "no reading goes into the corpus" describe a state that no longer exists. §8's "the store already records origin per update" as a door for session-level authorship is wrong in fact: `origin` is `local | remote` (`store.ts:54,150-156`), nothing identifies the writing session, so that door is closed until a column or the Yjs-client-id registration v2 mentions exists.

## 3. The nine claims of §11

| # | Claim | Verdict | Reason |
|---|---|---|---|
| 1 | Gate buildable on the pinned server; no browser-felt stall reintroduced | **survives (one option only)** | `beforeSync` gates update and reconnect-diff paths with no patch (probe); the listener option is falsified: ack sent, refused update broadcast, document goes silent (F2). The ≤5 s stall is accepted by design. |
| 2 | Fenced lease + lazy followers enough for R3; handoff acceptable | **weakened** | Fencing, wedged rule and holder-only compaction protect nothing the store does not already protect (F3); an idle MCP holder bounces the lease every TTL and each bounce is a full-corpus re-attach. Handoff cost is otherwise today's boot. |
| 3 | Awareness-only localhost provider is enough; "no `ub open`, no local presence" loses nothing | **weakened** | No such provider mode exists; both fakes cost double logging or a second full copy per room; `_directory` presence is uncovered offline (F4). Hub-only presence is the P5 cut. |
| 4 | Two upstream paths keep the pending set honest | **survives** | `clearPending` deletes only `seq <= min(marker, lastSeq)` and a process's ack covers exactly what that process applied and sent (`store.ts:404-406`, `replica.ts:1131-1142`, `sync.ts:942-948`); a stale process can clear nothing it has not seen acknowledged. Proof 2 confirms rather than discovers. |
| 5 | Removing IndexedDB leaves an acceptable window pre-launch | **weakened** | Owner decision stands; the window is a session after a sticky refusal, not an edit, because the editor stays editable and the client keeps redialling (F5). |
| 6 | `ub remote join` meets R2, including thousands of documents | **weakened** | Elevation works; the fresh-client verification of every document under a 15 s budget in waves of 32 refuses to persist past a few thousand documents (F8). A CLI budget, not a topology limit. |
| 7 | An unchanged hub is within reach for 50–100 holders | **unproven, as v2 says** | Holder = today's per-process fan-in made per-identity; the hub keeps every document loaded while any holder is connected (`Hocuspocus.ts:591-598`), so 100 always-on holders pin the whole corpus in hub memory and a restart is 100 × D handshakes. The probe's numbers, not argument. |
| 8 | D2 is the smallest cut and lost nothing v1 had right | **falsified on one point, over-built on three** | Lost: local browser search (F1). Over-built: fencing/wedged/holder-only compaction (F3), the awareness-only provider (F4), Proof 1's "no duplicated background work" bar (moot once duplication is harmless). |
| 9 | History/dashboard records hide no topology dependency | **survives, one correction** | Nothing in D2 collapses identities; but the store records no per-update session, so the authorship door v2 says is open is not (F10). |

## 4. v1 findings whose v2 disposition is wrong or incomplete

- **Fable F1 / Codex 1** — accepted, but the mechanism is half-falsified (listener option) and the named hook is the undecoded one; `beforeSync` is the seam (F2).
- **Fable F2** — accepted with a provider mode that does not exist; `_directory` presence is not covered offline (F4).
- **Fable F9 / Codex 8** — over-accepted: under P5 the right disposition was *rejected with evidence* — every holder-only write is already safe (F3).
- **Fable F8** — over-accepted on "only the holder compacts"; `readSince` already makes concurrent compaction safe (F3). The per-room `readSince` half is right.
- **Fable F11 / Codex 3** — accepted in substance, but the cut dropped R1's local browser search with the hub search (F1).
- **Codex 7 / Fable F12** — owner decision respected; the window is misdescribed in kind (F5).
- **Codex "crash matrix"** — "partly accepted" leaves out the one loss actually observed (F6).
- **Fable F4 / Codex claim 5** — Proof 0 is right, but §12's "#704 stays open" is stale and Proof 0 should retain the log that answers the question (F6, F10).
- **Fable F3, Codex 4, Codex 10, Fable F5/Codex 2, Fable F6/Codex 9, Fable F7/Codex 6, Fable F10, Codex 5** — dispositions hold.

## 5. Over-engineering check against R1–R5 and P1–P6

- **Lease generation, fenced transactions, wedged-holder rule, holder-only compaction** (§5.2) — no requirement needs them; the store's monotonic snapshot, transactional `readSince`, idempotent index replace and watermark-only `clearPending` already make every named write ghost-safe. P5 says drop them. Simpler: an advisory lease row plus a renewal timer, released on quarantine.
- **Awareness-only localhost provider** (§5.3) — a third origin class in the log observer plus a modified provider, or a second full copy per room, to deliver agent cursors offline that R1 does not ask for. Simpler: hub-relayed presence only; add a local channel if someone misses it.
- **Proof 1's "no duplicated or lost background work" and "exactly one holder" bars** — unmeasurable and unnecessary once duplication is harmless; keep the contention, stall and offline-create-restart-push bars.
- **Network-filesystem refusal** (§5.1) — a detection with no portable primitive; document the boundary.
- **Store schema version gate** (§7) — small, keep; note it cannot be enforced against a `ub mcp serve` spawned after a `git pull`, so "stop everything, upgrade, start" is a documented rule under P5, not a mechanism.
- Not over-engineered: the `beforeSync` gate, the `data_version` relay, two-level status, the pending-room exemption from laziness, the per-identity store key.

## 6. What v2 is missing entirely

- A browser search surface from the store's FTS (R1) — the one required property the cut does not meet (F1).
- `ub open`'s background settle loop and the two-document-per-room rule with its awareness bridge (F7).
- The served configuration document's second endpoint (localhost rooms versus the remote hub's name) and a refusal close reason the web client stops redialling on (F9).
- The upstream-outage-while-typing case in Proof 1b, and a retained log in Proof 0 so the observed loss is diagnosed from the append-only record rather than re-observed (F6).
- `beforeSync`'s contract and the `onUpgrade` refusal idiom in Obligation 2's seams test — the gate and the Origin check both rest on pinned-library behaviour that a bump could silently change (F2, F9).

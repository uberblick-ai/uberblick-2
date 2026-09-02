# Proof 1b — the gate and the bridge on pinned Hocuspocus 4.6.0

**Verdict: PASS for v3 §5.3–5.4, with the changes in §7 below.** The durable-before-ack gate is buildable on the pinned server through `beforeSync` alone, unpatched; no refusal leaked on either path; logging through the gate and the bridge is exactly-once; the upstream-outage case converged with no loss and no duplicated block. Two defects in today's `sync.ts` were found in passing (§9); they are not Proof 1b failures, but one of them decides how `ub open`'s loop may call `Replicas.settle()`.

Run 2026-09-02 on the worktree at `f0af6ae`, Node 26.3.1, `@hocuspocus/server` and `@hocuspocus/provider` 4.6.0, yjs 13.6.32, y-protocols 1.0.7. Throwaway code under `packages/mcp-server/spike/proof1b/` (untracked); results under the scratchpad `proof1b/` directory (`case1.json` … `case8.json`, `extras*.json`, `run-*.out|err`). No tracked file was modified; nothing was written to the live corpus or to `~/.local/share/uberblick`; every hub and store was a temp file on an ephemeral port.

## 1. What was built

One Node process, `open-standin.ts`, with the two halves v3 §5.3 describes, joined only by the store:

- **Replica half** — a real `MirrorStore` (subclassed only to add a one-shot refusal switch, an append ledger and `PRAGMA data_version`) and a real, unmodified `Replicas` attached to an in-process upstream hub (`createHub`, temp database, port 0).
- **Serving half** — an in-process Hocuspocus `Server` on `127.0.0.1`; "browser" clients are plain `HocuspocusProvider`s over loopback (in case 7 the stand-in runs as its own child process so it can be `SIGKILL`ed).
- **Gate** — `beforeSync`: ignores SyncStep1 and unknown sub-types, ignores frames from read-only connections, validates SyncStep2/Update bytes by applying them to a fresh scratch `Y.Doc`, skips the empty reconnect diff, appends the raw bytes to the store as `local` (pending mark included) and only then returns. A throw is an `Error` carrying `code: 4900` and a named `reason` (`uberblick:store-refused`, `uberblick:malformed-update`).
- **Bridge** — a loop (25 ms) woken by `PRAGMA data_version` *or* by this process's own appends, which runs `Replicas.settle()` and then replays each served room's tail (`readSince`: snapshot + tail) into the server `Document` with a marker origin `{source: "local", skipStoreHooks: true}`. The server `Document` is hydrated from the store in `onLoadDocument`, and dropped from the served set in `beforeUnloadDocument`.
- **Awareness bridge** — both ways between `document.awareness` and the replica's awareness, each side re-encoding the changed clients and applying with a bridge origin the other side filters.

## 2. Expected versus observed, per case

Every expectation was declared in `cases.ts` before the case ran; every check passed on the first run (`run-case*.out`).

| # | Case | Expected | Observed |
|---|---|---|---|
| 1 | Refusal, update path | Sender never acked (`unsyncedChanges` > 0, `isSynced` false), no row, other tab / server / hub / replica unchanged, connection closed with the gate's reason | A: `unsyncedChanges 1`, `isSynced false`, close `{code: 1000, reason: "uberblick:store-refused"}`; rows 2 → 2; server, B, hub (in memory and a hub-side peer) and the replica all still `"hello"` |
| 1 | Refusal, reconnect-diff path | Same for a client whose SyncStep2 carries an unsent edit | C: hook saw step1 then step2 (25-byte diff), refusal recorded as type 1, `unsynced 1`, `isSynced false`, same close reason, no row, `Z` nowhere |
| 1 | Afterwards | Later legitimate writes flow | B's `Y` acked, one row, server and hub `"helloY"`; a fresh client D hydrates `"helloY"`; B's `W` reaches D and the hub |
| 2 | Malformed frame | Refused before anything is stored; hydration afterwards succeeds | `[0xff,0x00,0x01]` and a real 18-byte keystroke cut to 9 bytes: both closed with `uberblick:malformed-update` ("Unexpected end of array"), no row, no ack; a fresh read-only hydration equals the server `Document`; a fresh client opens and writes |
| 2 | Control, no gate | Recorded, not asserted | A bare pinned server **acknowledged** the malformed update (`SyncStatus(true)`, no close, still synced): y-protocols swallows the decode error (`sync.js:82-90`), so an ack is not validation |
| 3 | Read-only write | Hook sees it, stores nothing; Hocuspocus answers `SyncStatus(false)` | `readOnlySkipped` +1, no row, server unchanged, client left with `unsynced 1`, not closed. The hook also saw the read-only client's empty handshake step2 (it runs before the readOnly check at `MessageReceiver.ts:217/259`) |
| 3 | Awareness | Never enters `beforeSync`; still relayed | Hook call counts unchanged while the awareness frame was handled; only sub-types 0/1/2 ever reached the hook; the read-only tab's presence reached the server `Document`, the replica and the hub |
| 4 | Browser write | One row (gate), one connection-origin server update, zero bridge-origin updates, one frame at the other tab | Exactly that; the sender also receives its own update back as one frame (Hocuspocus broadcasts to every connection, `Document.ts:305-318`), applied as a no-op |
| 4 | Own-replica write (`editBlock`) | One row (observer), one bridge-origin server update, one frame per tab | Exactly that |
| 4 | Other-process write (second `Replicas` on the store) | One row by that process, nothing appended by the stand-in, one bridge update, one frame per tab | Exactly that; 5 rows total for 2 seed + 3 writes. (E1 below: today's two-process path can log a *remote* duplicate of a write via the hub echo — 2 rows per write — independent of the bridge) |
| 5 | Awareness bridge | Browser → hub and hub → browser; no storm | Browser state reached the hub `Document` and a hub peer; the peer's state reached the browser. Burst of 20 field changes: hub applied 20, relayed 1 frame to the peer (coalesced), 1 echo to the browser. At rest, 6 s: **0 awareness frames** at the browser, at the hub peer and on the hub document (0/s) |
| 6 | Upstream outage | Writes stored and acked locally, room pending, MCP write lands; after restart everything converges, pending clears only after ack | Hub stopped → `hub-down`; 3 keystrokes acked in 1.28/0.61/0.62 ms; `pending_rooms` = `{room, seq 6}` then `seq 7` after the other process's write; pending survived a forced tick while down; hub restarted on the same port → `connected` → `isRoomQuiet` → pending cleared on the next tick; browser, replica, server `Document`, hub memory, fresh hub peer, old hub peer, store hydration and the other process all hold the one block `"helloabc+mcp"`, no duplicate ids |
| 7 | Serving-process death | Store holds every acked write; browser reconnects and converges; hub converges | Typing (15 ms/keystroke, 40 sent): acked 39, stored at death 39, in flight 1, lost-if-tab-died 1; restart 235 ms; recovered 40/40; hub converged. Burst (300 in one loop, kill immediately): acked 0, stored at death 25, lost-if-tab-died 275; recovered 300/300; hub converged |
| 8 | Cost | Sub-ms gate, few-ms ack; a foreign lock stalls; beyond `busy_timeout` it refuses | See §5 |

## 3. Pinned-library facts the implementation relies on

Server (`node_modules/@hocuspocus/server/src/…`, 4.6.0):

- `MessageReceiver.ts:189-194` — `beforeSync` is awaited with `{type, payload: message.peekVarUint8Array()}` before the `switch` that applies; for step2/update the payload is the raw Yjs v1 update (case 2/6: hydration from the stored bytes equals the live document). It runs for read-only connections too; their refusal comes later at `:217-239` (step2: `snapshotContainsUpdate` → ack true/false) and `:259-266` (update: `SyncStatus(false)`). Apply then ack: `:241-255`, `:268-281`. Unknown sub-types throw at `:284-285`.
- `MessageReceiver.ts:72-110` — awareness takes its own branch (`MessageType.Awareness`); no hook of the sync family runs, no readOnly check.
- `Connection.ts:270-298` — `beforeHandleMessage` (271) and `receiver.apply` (275) are awaited; any throw closes with the error's own `code` (if a number) and `reason` (if present), else `4205 Reset Connection` (292-295), and **empties the connection's queue** (296).
- `Connection.ts:208-222` and `OutgoingMessage.ts:147-154` — `close()` removes the connection from the document, runs the server-side `onClose` callbacks with the full event, and sends an in-band `MessageType.CLOSE` frame carrying **only the reason string**. The websocket stays open (E2: socket status `connected`; a second room on the same socket acked in 12 ms; the refused room's server connection count 0).
- Provider `MessageReceiver.ts:51-61` — the in-band CLOSE surfaces as `{code: 1000, reason}` to `onClose` / the `close` event; `HocuspocusProvider.ts:594-617` then sets `synced = false` and clears remote awareness; nothing redials (the socket never closed). So a custom **reason** reaches the client verbatim; the **code** is server-side only.
- `ClientConnection.ts:348-360` — the hook payload carries `connection` (so `connection.readOnly` is readable), `document`, `documentName`, `type`, `payload`. `:427-431` — frames queued during auth are drained before `connected`.
- `Document.ts:85-89` — the document's own `handleUpdate` listener is registered in the constructor; `:332-355` runs `onUpdate` then broadcasts (`flushDelay: 0` → `setImmediate` batch); `:298-319` broadcasts to every connection including the sender.
- `Hocuspocus.ts:373-505` — `onCreateDocument` (385) → `new Document` (395) → `onLoadDocument` (419-429; applying to `document` inside the hook is what the hub's persistence does too) → `isLoading = false` (436) → `onUpdate` wired (438-444) → `afterLoadDocument` (446). `:237-266` and `:600-637` — unload when the last connection leaves (`beforeUnloadDocument` fires).
- `Hocuspocus.ts:277-325` with `types.ts:15-19, 40-50` — a `{source: "local", skipStoreHooks: true}` origin skips the `onStoreDocument` debounce; the bridge's marker origin uses exactly that shape.
- Provider `HocuspocusProvider.ts:249, 398-417, 571-578` — the document `update` listener is live from construction and `send` checks only `_isAttached`: an update is sent whether or not the room is authenticated (§9). `:318-338` — `unsyncedChanges` increments per sent update and decrements only on `SyncStatus(true)` (provider `MessageReceiver.ts:94-98`); `:554-569` — `startSync` resets it to 1 and sends step1.
- `y-protocols/sync.js:82-90` — `readSyncStep2`/`readUpdate` catch and log; the server then acks (case 2 control).
- `@hocuspocus/common` `CloseEvents.ts` — `ResetConnection` is `4205 "Reset Connection"`.

Repository (unchanged, used as is):

- `store.ts:450-465` — the append and its pending mark are one transaction; `:483-498` — `readSince` reads snapshot and tail in one transaction; `:348` — `busy_timeout = 5000`; `:404-406, 609-611` — `clearPending` only through the acknowledged watermark.
- `replica.ts:496-528` — the observer logs every non-`LOG_ORIGIN` update; `:563-582` — `poll` replays with `LOG_ORIGIN`; `:1131-1142` — `releaseQuietRooms`; `:1085-1119` — `runSettle` waits for the hub whenever `settleNeeded` and re-owes it while `isDraining()` (1112).
- `sync.ts:134, 508-556, 973-1004, 1022-1049` — admission bound, `allQuiet`, `isDraining`, `waitForQuiet`.
- `PRAGMA data_version` (`dv-probe.mjs`): unchanged by the same connection's own commits, changed by another connection's.

## 4. What the seams test must pin (`packages/hub/test/hocuspocus-seams.test.ts`, Obligation 2)

1. `beforeSync` runs awaited before apply and before the ack, on both the update and the SyncStep2 paths; a throw leaves the document, the other connections and the sender's `unsyncedChanges` untouched (`MessageReceiver.ts:189-194, 241-281`; `Connection.ts:287-297`).
2. The thrown error's `reason` reaches the client verbatim in the in-band CLOSE with code 1000; the `code` does not; the websocket stays open and other rooms on it keep syncing (`Connection.ts:208-222`, `OutgoingMessage.ts:147-154`, provider `MessageReceiver.ts:51-61`).
3. The hook's `payload` for types 1 and 2 is the raw Yjs v1 update: stored as is, it hydrates.
4. The hook fires for read-only connections before their refusal, and for the empty 2-byte reconnect diff; it never fires for awareness frames.
5. A throw empties the connection's queue (`Connection.ts:296`): frames queued behind a refused one are dropped, so what follows a refusal is recoverable only by a reconnect diff.
6. Without the hook, a malformed update is acknowledged (`sync.js:82-90`): the ack is not validation.
7. A `{source: "local", skipStoreHooks: true}` origin skips `onStoreDocument` (`Hocuspocus.ts:311`, `types.ts:40-50`).
8. `Document` broadcasts every applied update to every connection including its origin (`Document.ts:305-318`): the sender's own update returns as a no-op frame.
9. A provider sends document updates before its token (`HocuspocusProvider.ts:249, 571-578`), and the hub counts an unauthenticated room's first frame as pending (`ClientConnection.ts:598-632`, terminate at `:604-609`) — the fact behind §9.
10. `onUpgrade` throwing crashes the process (`Server.ts:87-107`; the spike's destroy-then-reject idiom) — not exercised here, still owed.

## 5. Measured costs

Typing (150 keystrokes, 16–18-byte updates, one browser, in-process stand-in, `case8.json`):

| | p50 | p95 | max |
|---|---|---|---|
| scratch validate | 0.086 ms | 0.131 ms | 0.389 ms |
| append (one WAL transaction, pending mark included) | 0.104 ms | 0.176 ms | 3.58 ms |
| gate total | 0.187 ms | 0.302 ms | 3.68 ms |
| browser send → `SyncStatus(true)` | 0.52 ms | 0.97 ms | 7.7 ms |

Microbench: keystroke (18 B) scratch apply 0.043 ms, `Y.decodeUpdate` 0.001 ms; a 66 KB document as one update: apply 0.434 ms, decode 0.236 ms. Bridge latency (`extras.json` E3, 25 ms loop): own-replica write → browser frame p50 12.6 / p95 35.3 ms; other-process write → browser frame p50 12.8 / p95 36.2 ms. Idle tick cost of the loop at 303 attached rooms: `readSince` over every room 2.2 ms, whole tick 2.7 ms p50 (≈9 µs per room) — once the hub wait is out of it (§9).

Foreign write lock, second process (`lock-holder.mjs`, `BEGIN IMMEDIATE`): held 1.5 s → the append waited 1525 ms and was acked at 1526 ms; **the event loop was blocked for 1525 ms** (node:sqlite is synchronous), so every browser connection, the hub socket and the loop froze with it. Held 6.5 s → after 5248 ms the append failed with `ERR_SQLITE_ERROR: database is locked` (SQLITE_BUSY, errcode 5) and that connection was closed with `uberblick:store-refused`; the process then served other connections normally.

Loss window (case 7): at typing speed one keystroke was in flight at the kill and one would have been lost by a tab that also died; a live tab lost nothing (reconnect diff). In a burst of 300 sent in one loop, 25 were stored at death and 275 would have been lost by a dead tab; the live tab recovered all 300. The stand-in restarted in ~235 ms.

## 6. Reproduction

```
cd packages/mcp-server
# once: the spike dir needs the server package the mcp-server package does not depend on
mkdir -p spike/proof1b/node_modules/@hocuspocus
ln -sfn "$(readlink -f ../hub/node_modules/@hocuspocus/server)" spike/proof1b/node_modules/@hocuspocus/server
ln -sfn "$(readlink -f ../hub/node_modules/@hocuspocus/server/../../@hocuspocus/common)" spike/proof1b/node_modules/@hocuspocus/common
ln -sfn "$(readlink -f ../hub/node_modules/@hocuspocus/server/../../lib0)" spike/proof1b/node_modules/lib0
# (the links must point into THIS worktree's node_modules/.pnpm, or yjs loads twice)
node --no-warnings --import tsx spike/proof1b/cases.ts            # all eight, ~25 s
node --no-warnings --import tsx spike/proof1b/cases.ts --case=7   # one case
node --no-warnings --import tsx spike/proof1b/extras.ts           # E1–E4
node --no-warnings --import tsx spike/proof1b/extras2.ts          # E4b, E5
node --no-warnings --import tsx spike/proof1b/extras3.ts          # E6a, E6b
node <scratchpad>/proof1b/dv-probe.mjs                            # data_version semantics
```

`node --import tsx` rather than the `tsx` binary, for the same reason the test rig gives: the binary spawns a grandchild, and case 7's `SIGKILL` must hit the server. Results land in `<scratchpad>/proof1b/`.

## 7. Changes v3 needs

1. **§5.3, the loop's trigger.** `PRAGMA data_version` does not move for the connection that committed, and the gate and the replica observer commit on the store's own connection: a loop "driven by data_version" would never see a browser keystroke or a hub-origin update this process logged. Wake it from the store's append path as well (the stand-in sets a flag in `appendUpdate`), or poll `data_version` on a dedicated second connection.
2. **§5.3 / §7, "one loop, not two".** The loop must not call `Replicas.settle()` as it stands: `settle` bundles the local refresh with a bounded hub wait that runs on boot, after every reconnect, and — with the drain stuck as in §9 — on every call. In the stand-in that put 3.0 s in front of every tick (production config would put up to `connectTimeoutMs + syncTimeoutMs` = 4.5 s after each reconnect). Split `settle` into a public hub-free refresh (`pollAll`, `adoptKnownDocs`, reconciliation, `releaseQuietRooms`, compaction) that the loop runs, and a hub wait that only tool calls and boot use.
3. **§5.3 / §5.4, two refusal reasons.** A lock held by another process beyond `busy_timeout` surfaces as the same refusal as a disk failure. If refusal is sticky in the client, a 5-second lock wedges the tab until reload. Name `SQLITE_BUSY` separately (`uberblick:store-busy`, redial with backoff) from a real refusal (`uberblick:store-refused`, sticky, read-only). The close carries only the reason string, so the reason is the whole vocabulary.
4. **§5.4, the loss window's wording.** "The one update in flight" is right at typing speed (measured: 1) and wrong for a burst (a paste, IME composition, a large reconnect diff): the window is *everything sent and not yet appended* when `ub open` dies, widened by any busy-timeout stall; it applies only to a tab that also dies or reloads inside it — a live tab loses nothing.
5. **§5.3, the accepted stall is process-wide.** The append blocks the whole `ub open` process, not one connection: state it, since every other tab, the hub socket and the loop stall with it.
6. **§5.3, what the scratch validates.** An empty scratch validates decoding; a well-formed update with missing dependencies lands in `pendingStructs` without throwing (case 2), and Yjs integration of well-formed updates does not throw, so decoding is what protects replay. `Y.decodeUpdate` does the same 40× cheaper (0.001 vs 0.043 ms per keystroke) — either is fine at typing speed. The empty 2-byte reconnect diff must be skipped, not stored. The stored bytes are the browser's own (raw), not a Yjs re-encoding — which is why validation belongs here and not in the observer path.
7. **§5.7, `ub open` is not an agent.** `Replicas` publishes an agent presence in `_directory` from attach (`replica.ts:464-466`); through the awareness bridge the local tabs would count `ub open` itself as an agent session (the hub already does today). Null the stand-in's directory presence, as the spike did, or give it a distinct client kind.
8. **§5.3, "exactly once" is a gate/bridge property, not a store property.** E1: on today's code, one write across two processes on one store yields two rows (the writer's `local`, the receiver's `remote` via the hub echo) — harmless, idempotent, pre-existing. Say so, or a test written against "one row per write" will fail for reasons unrelated to the bridge.
9. **§5.3, cadence.** MCP-to-browser latency is the loop interval plus the tick: p95 ≈ 36 ms at 25 ms. Choose the interval with that number, and with the per-room `readSince` cost (~9 µs/room/tick, 2.2 ms at 303 rooms; a per-store max-seq fast path before it reaches thousands).
10. **§5.3, refusal stickiness is policy, not mechanism.** The stand-in refuses per connection and keeps serving; v3's "sticky and visible" is the client's reaction to the reason, which the proof shows the client can read. What the server does after its own store refused (quarantine the replica half, as an MCP process does) is unchanged from today.

## 8. What surprised me

- The pinned server acknowledges a malformed update when nobody gates it: y-protocols catches the decode error and the ack goes out anyway. A client's `synced` state proves nothing about what the server holds.
- The sender gets its own update back from Hocuspocus on every keystroke — one extra frame per keystroke, applied as a no-op.
- The hub coalesces an awareness burst of 20 into one relayed frame; at rest the bridge produced zero awareness traffic in 6 s.
- `data_version` is blind to the committing connection — obvious in the SQLite docs, easy to build a loop on regardless.
- The child stand-in came back in ~235 ms; a browser tab that kept typing through the death recovered every keystroke without a single lost character, both at typing speed and in a 300-keystroke burst.
- `SQLITE_BUSY` after a foreign lock is indistinguishable from a broken disk at the gate; the reason vocabulary has to distinguish them.
- Two pre-existing `sync.ts` problems fell out of the scale-ish probe (§9).

## 9. Found in passing — today's `sync.ts`, not the bridge (file as issues)

Reproduced on a bare `Replicas` with no stand-in (`extras3.json` E6a; `extras2.json` E5):

- **A write on a freshly attached room leaves before the room's token.** The provider's document listener is live from construction and `send` gates only on attachment (`HocuspocusProvider.ts:249, 571-578`); the admission bound (`sync.ts:134`) gates the *token*. Every `create_doc` is attach-then-write, so a burst of creations sends one un-authenticated first frame per room; the hub counts each as a pending document (`ClientConnection.ts:598-632`) and past `MAX_PENDING_DOCUMENTS` (100) terminates the whole socket (`:604-609`). 300 creations in a loop: 900 updates sent ahead of tokens, socket terminated once. Attaching the same 300 rooms *without* writes (E6b): bound intact, no termination.
- **After that termination, 32 admission slots stay held.** `attaching` stayed at 32 with `waiting` 0 and every room quiet; `isDraining()` therefore stays true, `settleNeeded` is re-owed on every settle (`replica.ts:1112`), and `allQuiet()` never holds — so **every `settle()` waits the full `syncTimeoutMs` (3.0 s measured)** until the process restarts. Today that is every tool call after such a burst, silently 3 s slower.
- With a small ceiling (5, a test seam) the client never recovers: a reconnect loop (15,285 socket generations in ~30 s), `unsyncedChanges` stuck at 13.

The first is the cause; the other two are its consequences. `ub remote join`'s verification and a markdown import are the realistic triggers.

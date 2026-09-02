# Where we landed — the re-cut proofs, night of 2026-09-02/03

**For Ben, in the morning.** Everything below ran locally, as throwaway code, with nothing committed, pushed, posted to GitHub or written to the live hub. The corpus record *Local-first per identity* carries the outcomes; the detailed reports sit beside this file, and the slide deck `findings-deck.html` is the short version.

## The one-paragraph answer

**The direction holds, and the spike's scariest finding was never real.** One store per identity, every process a full replica as today, `ub open` as a gated local sync server for the browser, presence via the hub, hub unchanged: the store proof and the gate proof pass every declared bar, and the scale probe finds no reason for lazy attachment or any hub-side change at three times your target. The daemon spike's "hub outage erased content" hard stop, which every review had to argue around, turned out to be the test harness triple-clicking a paragraph before typing. What the night found instead is **three small defects in today's code** and one in the pinned library, all with proven one-file fixes. Those become the first tickets; the topology work follows.

## Proof by proof

| Proof | Verdict | What it settled |
|---|---|---|
| Scale probe: 100 identities × 3 processes × 2000 docs | Informs: no phase 1b, no hub change | Hub at 2.2 GB and under 3% CPU idle over 603k room subscriptions; nothing refused, no ceiling fired; fresh hydration 8.9 s and flat in fan-in; propagation ~8 ms. The one strain is the restart storm at that size (101 s, a 0.93 s stall), caused by a quadratic guard in Hocuspocus 4.6.0. |
| Proof 0: the spike's content loss | Reproduced 6/6, then misdiagnosed | Named the destructive update precisely (delete every author's text, insert one character, browser-authored, valid) and showed it happens with no daemon at all. Wrongly concluded it was a live editor bug. |
| Proof 0b: root cause | **Harness artifact.** No editor bug. | The driver clicks the same spot three times under 500 ms apart; ProseMirror counts clicks itself and treats the third as a triple-click selecting the whole paragraph; the keystroke replaces the selection; y-prosemirror syncs exactly that. Predictions held 7/7: loss with the hub up, none after a real hub stop when the third click is spaced or absent. Same helper and cadence in the merged #704 spike driver. Identical on origin/main. |
| Proof 1: the shared store under load | PASS, conditional on two one-file fixes | Six processes on one WAL store: visibility p95 30 ms against a 250 ms bar; contended read/write latency at or below the single-process baseline; longest lock hold 204 ms; zero busy errors during service; zero gaps or torn reads under concurrent compaction; two processes converged through the store alone with the hub down; a document created by a killed process was pushed by a fresh one. |
| Proof 1b: the gate and the bridge | PASS | `beforeSync` gates the update path and the reconnect-diff path without patching the pinned server; refusals never acknowledged, broadcast or forwarded; malformed frames refused (an ungated server would acknowledge them); exactly-once logging in all three directions; awareness bridged without echo; hub outage converges; SIGKILL mid-typing loses nothing for a live tab. Gate cost 0.2 ms per keystroke. |

## Defects found in today's code (tickets to cut)

1. **The store can fail to open under concurrent starts** (Proof 1). `PRAGMA journal_mode = WAL` runs before `busy_timeout` in the store's constructor, so a quarter of simultaneous opens die with "database is locked" (121 of 480 with eight processes). Swapping the two lines: zero of 480. Live today with two MCP servers; `ub open` would add a third process to every start.
2. **A write on a freshly attached room is sent before its token** (Proof 1b). It bypasses the 32-wide admission bound; a burst of more than 100 `create_doc` calls gets the socket terminated by the hub, after which 32 admission slots stay held and every tool call waits 3 s until restart. Realistic triggers: a markdown import, `ub remote join`'s verification.
3. **Concurrent indexers can leave the search index stale forever** (Proof 1, confirming the Codex review). A wholesale index replace with no sequence loses a race, and nothing re-derives a document that stopped changing. Fix: `indexed_through_seq` per document with a conditional commit, where the cut is a contiguous log prefix the document has applied (after an append returns S, replay through S, then derive at S); measured at negative cost. The final Codex review caught that the proof's `max(lastSeq, lastAppendedSeq)` cut would certify an incomplete derivation; the ticket carries the corrected rule.
4. **Library: Hocuspocus 4.6.0's pending-document guard is O(rooms on the socket) per new room** (scale probe; verified in `ClientConnection.ts:234-242`, entries removed only on close or failure). A full-corpus attach costs O(D²) per socket; the whole restart storm at 2000 documents is this. A pnpm patch or an upstream fix; not urgent below a few thousand documents.

And one record correction: **the #704 spike's content-loss hard stop is a harness artifact**, not a topology property. The spike report, the topology record's post-merge note, and Proof 0's report all need that correction. The spike's other hard stop, a refused append reaching the hub through an ungated ingress, was real for that daemon cut and is exactly what the gate now prevents.

## What version three has to change (from the proofs)

- Say plainly that the gate guarantees replay safety, not content preservation: a valid but destructive update passes it by design, as it should.
- `ub open`'s loop must be woken by its own appends, since `PRAGMA data_version` never moves for the committing connection, and must not call `Replicas.settle()` as it stands; split a hub-free refresh out of it.
- Two refusal reasons: `store-busy` (transient, redial with backoff) and `store-refused` (sticky, read-only). One sticky reason would wedge a tab on a 5-second lock.
- The loss window is "everything sent and not yet appended", and only when the tab also dies: one keystroke at typing speed, most of a paste in a burst.
- The store append stalls the whole `ub open` process, not one connection.
- `ub open` must not announce itself as an agent in the directory room.
- Phase 1b's trigger gets numbers: 5.4 µs per room per settle, ~30 KB heap per document, 5.4 s boot at 3000 documents. The lazy-attachment trigger is a corpus size, not a feeling.
- Every observing process re-indexes a whole document on every observed update, and the writer re-indexes its own writes twice; accept it with the number, or schedule advancing `lastSeq` on local appends, which is the same bookkeeping the index fix needs and wants its own review.

## What the record says now

*Local-first per identity* (`2542cd66-b641-4900-96b4-5c461dcdcf65`) states the minimal cut and now carries the proof outcomes. *Product requirements* (`0950afda-0496-4e69-be4d-f5579dc7a44e`) is pinned under Start here. The detailed plan v3, both reconciliations, all four verdicts and the five proof reports are in this folder.

## Suggested order for tomorrow

1. Tickets for the three code defects and the library patch; the pragma order first, it is one line and live.
2. Correct the #704 record: the spike report's hard stop (a) and the topology record's note.
3. Phase-1 tickets from v3 §10 with the proof changes above folded in.

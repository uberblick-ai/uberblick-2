# Scale probe — today's protocol under ~100 identities × 3 processes

**Status:** measured 2026-09-02 on Ben's Mac Studio (Apple M2 Ultra, 24 cores,
64 GB, Node 26.3.1, macOS 25.6), against the hub and MCP sync code in the
worktree `open-issues-review-3ad97f` (branch `claude/repo-technical-audit-a759d7`
at `f0af6ae`). Throwaway local work: no issue, no PR, no commit, nothing posted
to GitHub, nothing written to the live corpus, nothing under
`~/.local/share/uberblick`, never the real hub or its config. Isolated temp
SQLite files and ephemeral ports only.

**It informs, it does not gate.** Its numbers decide phase 1b of
`v3-local-first-per-identity.md` §10 (lazy attachment plus an elected
always-attached process) and phase 2 (any hub-side work), and they answer three
of the evidence triggers in the corpus record *Topology decision parameters*
(`8d148677-93cc-4e7a-953f-67c65b77598f`): master fan-in after attachment,
full-corpus hydration time, and restart herding.

---

## 1. The short answer

**Nothing in today's protocol stops being comfortable at the owner's stated
target, and nothing stops being comfortable at three times it.** At 100
simulated identities × 3 full-replica processes over 2000 documents — 300
websockets carrying **602,903 room subscriptions** — the hub sat at **2.2 GB
RSS and under 3 % of one core**, no client was ever refused, the
100-pending-documents ceiling never fired, `MAX_REBUILDS` never fired, and a
brand-new replica still hydrated the whole 2000-document corpus in **8.9 s**,
which is what it takes with nobody else connected.

The first thing that stops being comfortable is not memory, not sockets and not
per-process memory. It is **hub CPU during the attach and reconnect storm**, and
it is superlinear in corpus size for a reason that is a bug in the pinned
library rather than a property of the topology: `ClientConnection`'s pending-
document guard is O(documents already on the socket) and runs once per document
attached, so joining a corpus of *D* documents on one socket costs the hub
**O(D²)** — see §6. At *D* = 500 that term is invisible (7 s for 300 sockets); at
*D* = 2000 it is the whole cost (100 s for the same 300 sockets, a 14× rise for a
4× corpus).

That term is also the whole of the restart storm. Re-attaching 300 sockets
after a hub restart takes **17 s** over 500 documents (worst event-loop stall
78 ms) and **101 s** over 2000 documents (worst stall **932 ms**) — same
sockets, same handshake count per room, 6× the time and 12× the stall for 4×
the corpus.

**Recommendation: phase 1b is not justified by these numbers, and no hub-side
change is either.** Keep eager attachment. If the corpus grows past a few
thousand documents *and* the process count stays this high, the cheapest fix by
an order of magnitude is a one-line counter in Hocuspocus (or a patch/upstream
PR), not lazy attachment plus an advisory lease. Detail and caveats in §7.

---

## 2. What was actually run

One hub — `createHub` from `packages/hub`, the same code the owner's Docker hub
runs in a container — in its own Node process so that RSS and CPU are
attributable to it and nothing else, on a temp SQLite file and an ephemeral
port.

A corpus of *D* real documents, built with `@uberblick/schema`'s own helpers
(`initDoc`, `appendBlock`) — one heading, 18 paragraphs, a fenced code block,
four list items, a GFM table and a marker paragraph, mean **7.5 KB** of encoded
Yjs state each — written into the hub's `documents(name, data)` table in exactly
the shape `packages/hub/src/persistence.ts` writes, together with a real
`_directory` document built with `upsertDirectoryEntry`.

Load: *N* simulated MCP processes, hosted 8-to-a-worker across 8 Node worker
processes. Each simulated process is **one websocket carrying every room**, as
`HubSync` does: admission paced in waves of `MAX_CONCURRENT_ROOM_ATTACHES` (32)
on the first connection *and on every re-open*, one auth message plus one sync
step 1 per room, full-jitter reconnect over `socketBackoff`'s band. The
simulated processes deliberately hold **no client-side Y.Doc**: they decode the
message envelope, answer the server's sync step 1 with an empty diff, and drop
the rest. The hub allocates exactly the same per-connection, per-document state
either way — that is the point — while 300 × 2000 real client documents fit on
no machine. (Fidelity check: the hub's own subscription count matched the
expected `sockets × rooms` exactly at every step.)

Two **real** replicas, each `MirrorStore` + `Replicas` from
`packages/mcp-server/src` on its own fresh temp store — the actual engine an
`ub mcp serve` process runs. One long-lived *writer*, one *watcher* started
fresh at every ramp step to time a cold full-corpus hydration while everyone
else is attached. Propagation is measured writer-process → hub → watcher-process
with `editBlock` on a real block.

Not measured, and worth saying: no tailnet, no WAN, no Docker. Everything is
loopback on one machine, so these numbers are a **fan-in and memory** answer,
not a latency-over-Tailscale answer (that is a separate trigger in the corpus
record and stays open).

---

## 3. D = 500 documents (503 rooms per process)

Steady state is sampled after every socket reports every room synced, plus 13 s
of idle. "Room subscriptions" is the hub's own sum of
`document.getConnectionsCount()` across all documents.

| identities | sockets | room subs | hub RSS | hub heap | hub CPU (idle) | attach | store write max | loop delay max |
|---|---|---|---|---|---|---|---|---|
| 10 | 30 | 15,593 | 285 MB | 120 MB | 0.8 % | 2.0 s | 4.5 ms | 6.7 ms |
| 30 | 90 | 45,773 | 400 MB | 188 MB | 0.4 % | 4.0 s | 4.5 ms | 8.0 ms |
| 60 | 180 | 91,043 | 560 MB | 312 MB | 1.1 % | 5.0 s | 4.4 ms | 6.7 ms |
| 100 | 300 | 151,403 | 770 MB | 478 MB | 1.4 % | 7.0 s | 4.7 ms | 10.0 ms |

Marginal hub cost: **≈ 3.6 KB of RSS per room subscription**, dead linear across
the range. Idle CPU never left the noise floor: with 300 sockets and 151,403
subscriptions attached and quiet, the hub used **1.4 % of one core**.

| identities | fresh replica hydration | fresh replica RSS | writer replica RSS | propagation (5 runs, ms) |
|---|---|---|---|---|
| 10 | 0.98 s | 227 MB | 235 MB | 3 / 4 / 5 / 5 / 6 |
| 30 | 0.96 s | 222 MB | 237 MB | 3 / 3 / 4 / 4 / 6 |
| 60 | 0.91 s | 217 MB | 238 MB | 5 / 5 / 7 / 7 / 8 |
| 100 | 0.91 s | 225 MB | 177 MB | 7 / 8 / 8 / 10 / 12 |

Baseline: the writer hydrated 500/500 in **1.07 s** with nothing else connected.
Hydration is therefore **flat in fan-in** — 300 other processes attached cost a
cold replica nothing measurable. Propagation between two identities' processes
roughly doubles from 30 to 300 sockets, from ~4 ms to ~9 ms, and is still an
order of magnitude below anything a person or an agent notices.

Restart storm (graceful `hub.stop()`, then `createHub` on the same port and
database; the resync clock starts once every socket has observed its close and
stops when every socket has every room synced again):

| sockets | handshakes | stop | listening | resync | 4205 closures | ceiling hits | loop delay max |
|---|---|---|---|---|---|---|---|
| 90 | 45,270 | 0.51 s | 0.20 s | **6.2 s** | 0 | 0 | 70 ms |
| 300 | 150,900 | 1.59 s | 0.19 s | **17.2 s** | 0 | 0 | 78 ms |

---

## 4. D = 2000 documents (2003 rooms per process)

| identities | sockets | room subs | hub RSS | hub heap | hub CPU (idle) | attach | store write max | loop delay max (idle) |
|---|---|---|---|---|---|---|---|---|
| 30 | 90 | 182,273 | 1014 MB | 725 MB | 1.5 % | 29.1 s | 4.5 ms | 8.7 ms |
| 100 | 300 | 602,903 | 2249 MB | 1699 MB | 2.7 % | 100.2 s | 4.5 ms | 14.5 ms |

The hub pushed **6.27 GB** of sync-step-2 state to the load clients over the
whole *D* = 2000 run (300 sockets × 2003 rooms × 7.5 KB for the last step alone
is 4.5 GB of it).

Marginal hub cost: **≈ 2.9 KB of RSS per room subscription** — the same linear
term as at *D* = 500, so 2.2 GB at 600 k subscriptions is not a surprise and not
a wall on a 64 GB machine (nor on a 4 GB VPS *if* the process count is the
owner's real 20 × 3 = 60 rather than 300: that is ≈ 120 k subscriptions,
≈ 0.9 GB).

| identities | fresh replica hydration | fresh replica RSS | writer replica RSS | propagation (ms) |
|---|---|---|---|---|
| — (baseline, unloaded) | 8.49 s | — | — | — |
| 30 | 8.82 s | 371 MB | 428 MB | 5 / 6 / 7 / 10 / 11 |
| 100 | 8.87 s | 396 MB | 298 MB | 7 / 8 / 8 / 8 / 8 |

Hydration is again **flat in fan-in**: 8.5 s alone, 8.9 s with 300 other
processes attached over 600 k subscriptions.

Per-replica-process RSS — the cost of eager attachment on a developer machine,
plan §5.2's accepted risk and weakest claim 4:

| corpus | RSS per full-replica process |
|---|---|
| 500 documents | **≈ 220–240 MB** |
| 2000 documents | **≈ 370–430 MB** |

Three such processes on one laptop is ~1.2 GB at 2000 documents. That is a real
number and it is not alarming; the corpus would have to reach roughly 20,000
documents before three processes cost 4 GB.

Restart storm at 2000 documents:

| sockets | handshakes | stop | listening | resync | 4205 closures | ceiling hits | loop delay max |
|---|---|---|---|---|---|---|---|
| 300 | 600,900 | 7.02 s | 0.21 s | **101.4 s** | 0 | 0 | **932 ms** |

This is the probe's high-water mark and the only place anything looked strained:
a **0.93 s event-loop stall** inside the hub while 300 sockets re-handshook
600,900 rooms. Correctness was untouched — every socket came back, nothing was
refused, nothing hit a ceiling — but for ~100 s the hub is a poor citizen, and
during the worst of it a single message can wait nearly a second. Both the
101 s and the 932 ms are dominated by the quadratic scan in §6, not by the
handshakes themselves: the same 300 sockets over a 500-document corpus resync in
17 s with a 78 ms worst stall.

---

## 5. Which limits fired

**None.**

- `MAX_PENDING_DOCUMENTS` (hub, 100 per socket) — **never fired**, at any step,
  first attach or restart. The client's wave of 32 held on every connection, as
  its comment promises. Zero sockets were terminated with 4205, and the hub
  logged no "too many pending unauthenticated documents" warning.
- `MAX_REBUILDS` (MCP client, 3) — **never reached**. No room was disowned on a
  live connection at any scale; the only closes were the socket-level ones a hub
  restart causes, which `hubDisownedRoom` ignores by design.
- Token refusals — zero across ~1.6 million auth handshakes.
- Hub persistence — the debounce did what it says. The longest single
  synchronous `onStoreDocument` full-state upsert observed anywhere in the probe
  was **4.7 ms**, mean 1.3–1.9 ms, and a burst of five block edits produced ten
  store writes, not ten per edit. The corpus record's note that this write can
  block for up to five seconds under lock contention remains *possible* and was
  never *observed*: nothing else was writing that database.
- Event-loop delay — **≤ 14.5 ms** at every steady state (the monitor's own
  floor at 5 ms resolution is ~6.4 ms, so that is essentially zero). Under the
  restart storm it rose to 70–78 ms at 500 documents and to **932 ms** at 2000
  documents × 300 sockets, which is the one figure in this probe that would be
  unpleasant in production.

---

## 6. The one real finding: the attach cost is O(D²) per socket, in the library

Attach time for 300 sockets went from **7.0 s** at 503 rooms to **100.2 s** at
2003 rooms — 14× for a 4× corpus. That is not the wire and not the crypto; both
are linear in handshakes. It is this, in `@hocuspocus/server` 4.6.0
(`dist/hocuspocus-server.cjs`, `ClientConnection`):

```js
if (this.incomingMessageQueue[rawKey] === void 0) {
  if (this.getPendingDocumentCount() >= this.maxPendingDocuments) { … terminate … }
  …
}
…
getPendingDocumentCount() {
  let total = 0;
  for (const rawKey of Object.keys(this.hookPayloads))
    if (!this.hookPayloads[rawKey].connectionConfig.isAuthenticated) total += 1;
  return total;
}
```

`hookPayloads` is **not** deleted when a document authenticates successfully —
only when it fails or when the connection closes — so it grows to one entry per
room on the socket. `getPendingDocumentCount()` rebuilds the key array and walks
all of them, and it is called once for every *new* document on that socket. One
socket joining *D* rooms therefore costs the hub `O(D²)` — 2003² ≈ 4 M
iterations per socket, 1.2 **billion** across 300 sockets, all of it on the hub's
single event loop (plus `Object.keys` allocating a 2003-element array each
time). At 503 rooms the same term is 76 M iterations and disappears into the
noise.

The irony worth recording: **the pending-documents guard is itself the quadratic
cost**, and `MAX_PENDING_DOCUMENTS`'s own doc comment already says the number is
"a memory-amplification guard, not a capacity knob". Nothing about our client is
at fault — waves of 32 are what keep the *count* low; they cannot keep the
*scan* short.

This is a library defect with a small fix (keep a running counter, or delete the
payload once `isAuthenticated`), not a topology fact. It should be recorded
against Hocuspocus obligation tracking and, if it ever bites, fixed there.

---

## 7. Recommendation

**Do not build phase 1b on this evidence.** Lazy attachment plus an advisory
lease electing an always-attached process is a real amount of machinery — and,
as *Topology decision parameters* already records, lazy attachment is not a
cheap internal optimisation, because search and backlinks read an index only
attached replicas populate. Buying that with these numbers would be paying for a
problem that does not exist:

- **Hub memory** is linear and small: ~3 KB per room subscription, 2.2 GB at
  600 k subscriptions, ~0.9 GB at the owner's actual 20 people × 3 processes ×
  2000 documents. Lazy attachment would reduce a number nothing is straining
  against.
- **Sockets** are already consolidated: one per MCP process, not one per room.
  300 sockets is nothing for one Node process.
- **Steady-state hub CPU** is 1–3 % of one core with 300 processes attached.
- **Hydration** — the trigger the corpus record says "decides ephemeral agents,
  relay warm-up, and the corpus bound" — is **flat in fan-in** and modest in
  corpus size: 1 s per 500 documents, 8.9 s per 2000, whether or not 300 other
  processes are attached. There is no herding penalty for a cold client.
- **Restart herding** — the other trigger — is 6 s at 90 sockets and 17 s at 300
  for a 500-document corpus, with zero refusals and no ceiling breach. At 2000
  documents × 300 sockets it is 101 s with a 0.93 s worst-case event-loop stall,
  which is the one result that argues for *something*. But the something it
  argues for is the §6 fix: the storm is quadratic in corpus size because of the
  library scan, not because 300 clients re-handshake. Electing one
  always-attached process per identity cuts sockets 3× and so cuts the storm
  roughly 3× (300 → ~100 sockets reads across as 17 s → 6 s at *D* = 500, the
  90-socket row) — but leaves it quadratic in the corpus, so it buys back only
  what one more doubling of the corpus takes away. Fixing the scan removes the
  superlinear term outright.

**No hub-side change is justified either**, with one narrow exception that is
not really "hub-side work" in the plan's sense: if the corpus is heading past a
few thousand documents, fix or patch `getPendingDocumentCount()`. That single
counter removes the only superlinear term the probe found, and it costs
approximately one line against the alternative of an election protocol.

If the owner nonetheless wants the restart storm shorter, the cheap lever is the
wave size, not the topology: `MAX_CONCURRENT_ROOM_ATTACHES` is 32 against a
ceiling of 100 and the probe shows the hub is nowhere near either limit. Raising
it is a measurement question, not a design question — but there is no evidence
today that 17 s of reconnect after a hub restart is worth changing anything for.

**What would change this answer.** Any of: a corpus past ~5000 documents with
the pending-count defect unfixed; a hub host with under ~2 GB of RAM at 60+
processes; a measured tailnet hydration time far worse than the loopback 8.9 s
(that is the untested half of the hydration trigger); or presence semantics —
which this probe did not measure at all and which the corpus record already
names as the real casualty of eager attachment ("every document appears to
contain every agent"). Presence is an argument for an active-document model, not
for lazy attachment, and it is unaffected by anything measured here.

---

## 8. What surprised me

1. **How boring the hub is at rest.** I expected fan-in to show up as steady
   CPU. 602,903 room subscriptions cost 2.7 % of one core when idle. The hub is
   an event router with nothing to route until somebody types.
2. **Hydration does not care about fan-in at all.** I expected a cold replica to
   be starved while 300 others held the hub. It hydrated in 8.87 s under full
   load against 8.49 s alone — inside the noise. The 32-wave admission and the
   per-socket independence of Hocuspocus' queues are doing their job.
3. **The bottleneck was in the library, not in our code, and it was hiding
   behind the very guard that exists to protect the hub.** I went in expecting to
   report either "hub RSS is the wall" or "the handshake storm is the wall";
   the honest answer is "a quadratic scan in a dependency is the wall, and only
   past ~1000 documents".
4. **`MAX_PENDING_DOCUMENTS` was never even approached.** The corpus record's
   "new hard fact" that eager attachment hit this wall at ~100 live documents is
   now firmly historical: with waves of 32 it does not fire at 2000 documents ×
   300 sockets.
5. **Per-replica-process memory is smaller than the fear.** ~0.4 GB for a
   2000-document corpus, so three processes are ~1.2 GB. Plan §5.2's "memory per
   process is the corpus size, accepted on developer machines" is comfortably
   true, with roughly a 10× headroom before it stops being.
6. **The restart storm is where the quadratic bites hardest.** 300 sockets over
   2000 documents took 101 s to resync and stalled the hub's event loop for
   932 ms at its worst — against 17 s and 78 ms for the same sockets over 500
   documents. If anything ever motivates work here, it is this row, and the
   cheapest lever remains §6 rather than the topology.
7. **A self-inflicted one worth writing down**, because it nearly produced a
   fabricated result: the first run of this probe reported a hub restart resync
   of **207 ms**, which was measuring nothing — the load clients had not yet
   processed their close events, so the pre-outage counters were still full when
   the first sample was taken. The corrected figure for the same step is 6.2 s,
   30× larger. A "suspiciously good" number in a probe is a bug until proven
   otherwise.

---

## 9. Reproduction

All probe code is untracked, under
`packages/mcp-server/spike/scale/` in the worktree
`/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f`.
No tracked file was modified. `pnpm` is not on this shell's PATH; the package's
own `tsx` is used directly (`mise exec -- pnpm --filter @uberblick/mcp-server
exec tsx …` is equivalent).

```sh
cd /Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f/packages/mcp-server
SCRATCH=/private/tmp/claude-501/-Users-ben-Projects-Uberblick-uberblick-crdt--claude-worktrees-open-issues-review-3ad97f/26d31aab-5516-4f34-bbb7-c5d8e86b57f2/scratchpad/scale

# 500 documents, 10/30/60/100 identities × 3 processes, restart storm at 30 and 100
./node_modules/.bin/tsx spike/scale/run.ts \
  --docs 500 --steps 10,30,60,100 --processes 3 --workers 8 \
  --restart-at 30,100 --scratch "$SCRATCH/d500" --out "$SCRATCH/d500/results.json"

# 2000 documents, 30 and 100 identities × 3, restart storm at 100
./node_modules/.bin/tsx spike/scale/run.ts \
  --docs 2000 --steps 30,100 --processes 3 --workers 8 --hub-heap 16384 \
  --restart-at 100 --scratch "$SCRATCH/d2000" --out "$SCRATCH/d2000/results.json"
```

Each run seeds its own hub database on first use (cached at
`<scratch>/hub-d<D>.sqlite`; delete it to reseed), binds an ephemeral port, and
removes its replica stores on exit. Raw per-step JSON is at
`$SCRATCH/d500/results.json` and `$SCRATCH/d2000/results.json`; the console
transcripts are `run2.log` and `run.log` beside them.

Files:

- `spike/scale/common.ts` — constants and a hand-rolled Hocuspocus 4.6.0 wire
  codec (lib0 varUint/varString), so the load clients need no client-side Y.Doc.
- `spike/scale/seed.ts` — builds *D* real schema documents plus a real
  `_directory` and writes them as hub `documents` rows.
- `spike/scale/hub-proc.ts` — `createHub` in its own process, with
  `onStoreDocument` timed and `monitorEventLoopDelay` armed.
- `spike/scale/load-worker.ts` — many simulated MCP processes per worker: one
  socket each, waves of 32, full-jitter reconnect.
- `spike/scale/replica-probe.ts` — a real `MirrorStore` + `Replicas` process
  (hydration timing, RSS, edit propagation).
- `spike/scale/run.ts` — the orchestrator and the ramp.

### Caveats on the method

- The corpus is seeded by writing encoded Yjs state straight into the hub's
  `documents` table rather than by calling `create_doc` 2000 times. The
  documents and the rows are real; the creation path is not exercised.
- Load clients hold no Y.Doc, so this measures **hub** cost faithfully and says
  nothing about client CPU at that fan-in. The two real replicas cover the
  client side.
- Everything is loopback on one machine. Tailnet latency classes, DERP paths and
  sleep/wake are untested and remain an open trigger in the corpus record.
- `hub.stop()` is a graceful shutdown, the same thing a container restart does.
  A `SIGKILL`ed hub was not tested.
- Propagation is wall-clock across two processes on one machine, measured from
  the writer's post-`editBlock` timestamp to the watcher's update observer.

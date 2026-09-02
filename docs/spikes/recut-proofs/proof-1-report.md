# Proof 1 — the shared store under load

**Verdict: PASS for v3 §5.1–5.2, conditional on two proven one-file fixes.**

One SQLite store per identity, used directly by six OS processes at once, stays
correct and fast enough under realistic contention. Every correctness case
passed. Every latency bar passed at both realistic paces. Two defects were found
in the code as it ships — one of them new, and it is the reason the verdict is
"conditional" rather than unqualified:

1. **`MirrorStore`'s constructor can die with `database is locked`.** It sets
   `PRAGMA journal_mode = WAL` *before* `PRAGMA busy_timeout = 5000`, so the one
   statement that needs a lock runs with no busy handler installed. With eight
   processes opening one store in the same instant: **121 failures in 480 opens
   (25%)**. Swapping the two lines: **0 in 480**. This is a live bug today
   (CLAUDE.md calls two MCP servers on one file "the normal case") and v3 makes
   it more likely, because `ub open` adds another process to every start-up.
2. **The wholesale index replace does leave FTS rows stale.** The v2 Codex claim
   is **confirmed** with a concrete interleaving: both replicas hold
   `stateCharlie` while `docs_fts` says `stateBravo`, and nothing repairs it.
   v3 §5.2's `indexed_through_seq` fixes it, at no measurable cost (p95 *lower*
   than today's path).

Neither is a reason to stop: both are small, local, and proven fixed here. A
third finding — the per-settle cost of eager attachment — is not a defect but a
number phase 1b now has (§ "Scale").

Machine: 24-core Apple Silicon, 64 GB, macOS 26.6.2, node v26.3.1, `node:sqlite`
(`DatabaseSync`), WAL, `busy_timeout` 5000. All code is throwaway and untracked,
under `packages/mcp-server/spike/proof1/`; no tracked file was modified, nothing
was committed, pushed, or written to the live corpus or hub.

---

## 1. Bars, declared before the first measurement

Declared in `scratchpad/proof1/BARS.md` before any run. Three write paces, each
measured separately (the pace split was added after a 3-second plumbing smoke
run, before any measurement run; no threshold was changed):

- **agent** — one edit every 250 ms: an agent working through MCP, back to back.
- **typing** — one edit every 25 ms: the browser typing through `ub open`'s gate,
  the realistic ceiling v3 §5.3 creates (one store append per keystroke-sized
  update).
- **burst** — back to back, no pause: a stress ceiling far above any real client.
  Reported for information; B2c's absolute bound is judged on agent and typing.

| # | Bar | Threshold |
|---|-----|-----------|
| B1a | writer commit → visible in a reader's next read | p95 ≤ 250 ms, max ≤ 1000 ms |
| B1b | writer commit → visible in the serving loop | p95 ≤ 150 ms, max ≤ 1000 ms |
| B2a | read latency vs single-process baseline, same run | p50 ≤ 3×, p95 ≤ 5× |
| B2b | write latency vs baseline | p50 ≤ 3×, p95 ≤ 5× |
| B2c | absolute under contention | read p95 ≤ 150 ms, write p95 ≤ 250 ms |
| B3 | longest SQLite write-transaction hold | max ≤ 500 ms |
| B4 | serving loop's longest single settle | max ≤ 500 ms, p95 ≤ 100 ms |
| B5 | `SQLITE_BUSY` escaping to a caller as a failure | 0; any occurrence is a STOP |
| C1–C2 | reader sees a gap, a torn state or a backwards read | 0; any is a STOP |
| C3 | compactions driven on the room | ≥ 4 |
| C4 | every reader converges on the writer's final text | all |
| D1 | confirm/refute the stale-index claim | evidence either way |
| D2 | cost of the `indexed_through_seq` check | p95 overhead ≤ 1.0 ms, p50 ≤ 30 % |
| D3 | with the fix, the same interleaving leaves the index current | required |
| E1 | both replicas and the hub's persisted doc converge after an outage | required |
| E2 | `pending_rooms` holds a room with unacknowledged local work while the hub is down | required |
| E3 | it clears after the hub acknowledges | required, ≤ 30 s |
| E4 | doc created offline by a killed process is pushed by a fresh one | required, ≤ 30 s |
| F1–F2 | offline create survives SIGKILL, is pushed, pending clears | required |

---

## 2. Case 1 — contention

Six separate OS processes on one WAL store file: four readers looping
`get_doc`-equivalent reads, one writer doing `edit_block`-equivalent writes, one
`ub open` stand-in polling `PRAGMA data_version` every 20 ms on a second
connection and replaying every room's tail on change. Corpus: 30 documents ×
10 paragraph blocks, plus `_directory`, `_sidebar`, `_feedback` — 34 rooms per
process. Baseline: the same work in one process, alone, earlier in the same run.

Realised paces: agent 3.9 writes/s (98 writes), typing 35 writes/s (700),
burst 1 330 writes/s (19 958).

### Visibility — commit to first sighting elsewhere (ms)

| phase | reader p50 | reader p95 | reader max | serve p50 | serve p95 | serve max | bar |
|---|---|---|---|---|---|---|---|
| agent | 15.0–16.7 | 27.7–28.7 | 31.5 | 11.0 | 21.8 | 23.6 | **pass** |
| typing | 17.8–20.2 | 28.6–30.4 | 41.0 | 12.6 | 22.8 | 36.4 | **pass** |
| burst | 16.9–17.9 | 44.1–80.2 | 234.4 | 14.1 | 50.9 | 158.7 | **pass** |

Bar B1a is p95 ≤ 250 ms / max ≤ 1000 ms; B1b is p95 ≤ 150 ms / max ≤ 1000 ms.
Worst observed p95 is 80 ms and worst max 234 ms, both in the unrealistic burst.
Readers poll at ~25 ms, so roughly half the median lag is the reader's own
cadence, not the store.

### Latency, contention against the same-run baseline (ms)

Reads are the full `settle()` + two `get_doc`-equivalent reads. Writes are the
mutation only — diff-and-splice, the synchronous log append, the index write —
because the settle a real `edit_block` also pays is what the read column
measures. A real contended agent-pace `edit_block` is therefore about
1.2 + 1.35 ≈ 2.6 ms at p50.

| phase | baseline read p50/p95 | contended read p50/p95 | ratio p50/p95 | baseline write p50/p95 | contended write p50/p95 | ratio p50/p95 |
|---|---|---|---|---|---|---|
| agent | 1.66 / 2.88 | 1.20 / 2.39 | 0.72× / 0.83× | 1.88 / 3.71 | 1.35 / 2.39 | 0.72× / 0.64× |
| typing | 1.66 / 2.44 | 1.42 / 3.69 | 0.86× / 1.51× | 1.66 / 2.67 | 0.59 / 1.56 | 0.36× / 0.58× |
| burst | 0.34 / 0.48 | 1.21 / 12.83 | 3.56× / **26.7×** | 0.19 / 0.32 | 0.22 / 1.56 | 1.16× / 4.88× |

**B2a and B2b pass at agent and typing pace** — contention is at or below the
single-process baseline. **B2a's p95 ratio is missed in the free-running burst
only** (26.7× against a 5× bar). B2c, the absolute bar, passes everywhere: worst
contended read p95 is 12.8 ms against 150 ms, worst max 205 ms; worst write p95
1.56 ms against 250 ms.

That ratio miss is not a contention result. The single-process baseline reads
after each of its own writes, so it replays ~1 log row per read; the contended
reader manages 1 969 reads against the writer's 19 958 rows, so it replays ~10
rows per read *and re-indexes the document each time*. **Read cost under
contention is dominated by how many updates arrived since the last read, not by
lock waiting.** At 1 330 writes/s — 33× the typing ceiling, 340× an agent — that
is the expected shape, and the absolute number stays an order of magnitude
inside the bar. Recorded as a miss; not a credible failure.

### Lock holds and the serving loop

| metric | agent | typing | burst | bar |
|---|---|---|---|---|
| longest write-transaction hold, any process (ms) | — | — | **204.5** | ≤ 500 **pass** |
| serving-loop settle p95 (ms) | 3.34 | 3.03 | 11.36 | ≤ 100 **pass** |
| serving-loop settle max (ms) | 6.20 | 14.79 | 109.98 | ≤ 500 **pass** |
| `SQLITE_BUSY` reaching a caller | 0 | 0 | 0 | 0 **pass** |
| read/write failures of any kind | 0 | 0 | 0 | — |

Every long hold is an **index** write, and every one of them is in an *observing*
process, not the writer:

| process | index writes | index p95 | index max (ms) |
|---|---|---|---|
| writer | 41 542 | 0.29 | 41.5 |
| reader-1 | 1 307 | 4.94 | **204.5** |
| reader-2 | 1 318 | 4.88 | 93.5 |
| reader-3 | 1 306 | 4.95 | 161.4 |
| reader-4 | 1 300 | 4.74 | 125.1 |
| serve | 1 432 | 4.72 | 109.1 |

Five processes rewriting one document's FTS rows on every replay is where the
single writer lock actually goes. `readSince` never blocks: 705 772 calls in the
writer at p95 0.01 ms, 1 351 772 in the baseline at the same.

**Write amplification, measured:** the writer issued **41 542 index writes for
20 756 appends — exactly 2×**. `Replica.lastSeq` only advances on replay, so a
process's own local write is read back out of the log by its next `settle()`,
counted as applied, and re-indexed. See §7.

---

## 3. Case 1c (new) — opening the store, several processes at once

Found when case 3 crashed. `MirrorStore`'s constructor:

```
this.db.exec("PRAGMA journal_mode = WAL");    // needs a lock, can return BUSY
this.db.exec("PRAGMA busy_timeout = 5000");   // installs the busy handler
```

The first connection to open a WAL database builds the shared-memory index; when
several processes do that in the same instant the losers get `SQLITE_BUSY` (5) or
`SQLITE_BUSY_RECOVERY` (261), and with no busy handler installed the constructor
throws and the process dies before it serves anything.

| pragma order | processes | rounds | opens | failures |
|---|---|---|---|---|
| **shipping** (`journal_mode` first) | 8 | 60 | 480 | **121 (25 %)** |
| **swapped** (`busy_timeout` first) | 8 | 60 | 480 | **0** |

Open latency is unchanged (p50 3.26 ms → 3.44 ms). This is bar B5 missed — a
busy error escaping to a caller as a failure — at construction rather than
during service, with a one-line remedy proven to eliminate it. It is why the
verdict is conditional.

Not hypothetical for v3: §5.1 puts every MCP session and `ub open` on one file,
and a machine that starts an editor with two agent sessions opens it two or three
times in the same moment.

---

## 4. Case 2 — compaction under contention

One writer drives one room far past the production threshold (500 rows per room)
while readers replay it through `readSince`. Every read checks the whole block
text against the only sequence the writer can have produced (`0 1 2 … k`), so a
dropped update shows as a hole and a torn read as a suffix belonging to no k; a
second block nobody edits is checked for corruption on every read too.

| run | writes | readers | who compacts | snapshot advances | refused (stale) snapshots | reader reads | violations | converged |
|---|---|---|---|---|---|---|---|---|
| 2a | 3 000 | 3, tight loop | writer only | 6 | 0 | 2 180 | **0** | 3/3 |
| 2b | 5 000 | 3, 200 ms pause | writer only | 10 | 0 | 103 | **0** | 3/3 |
| 2c | 5 000 | 3, 25 ms pause, one stalling 300 ms inside `compact` | **readers only** | 10 | **2** | 335 | **0** | 3/3 |

Run 2c is the decisive one. With the writer's own threshold raised out of reach,
all three readers compacted concurrently, and the deliberately slow one committed
two snapshots that a newer one had already overtaken: `putSnapshot`'s monotonic
`WHERE snapshots.through_seq < excluded.through_seq` refused both (`wrote:false`
at `throughSeq` 2017 and 3445) while its prune still ran. No reader ever saw a
gap, a torn state or a backwards read, and all three finished on the writer's
exact final text (23 894 characters). C1–C4 **pass**.

This is direct evidence for v3 §3's claim that every-process compaction is safe
by `readSince`'s transactional read of snapshot-plus-tail.

---

## 5. Case 3 — index sequencing race

Two processes on one store index one document from different log cuts. The slow
one is stalled between deriving its rows and committing them (300 ms → 2.5 s), so
it commits last.

| step | document in both replicas | `docs_fts` body |
|---|---|---|
| B writes cut 2 | stateBravo | stateBravo |
| B writes cut 3 (A stalled) | stateCharlie | stateCharlie |
| A commits its cut-2 derivation | **stateCharlie** | **stateBravo** ← stale |

**Confirmed.** After the race, a search for `stateCharlie` returns nothing and a
search for `stateBravo` returns the document, while every replica holds
`stateCharlie`. Nothing repairs it: index writes ride observed updates, and that
document has none coming.

With the `indexed_through_seq` prototype (`spike/proof1/sequenced-store.ts` —
the cut captured at derivation time, rows and cut written in one
`BEGIN IMMEDIATE` transaction that refuses to go backwards), the same
interleaving leaves the index at `stateCharlie`; the slow write is skipped
(`skipped: 1`). D1 and D3 **pass**.

### Cost of the check (2 000 index writes, single process, no contention, ms)

| path | p50 | p95 | p99 | max | mean |
|---|---|---|---|---|---|
| today (`MirrorStore.indexDoc`) | 0.07 | 0.17 | 0.24 | 0.92 | 0.08 |
| sequenced (gate + rows in one txn) | 0.07 | **0.11** | 0.13 | 0.29 | 0.08 |

D2 **passes** with room to spare: p50 identical, p95 *lower*. The gate adds one
indexed `SELECT` and one upsert but replaces a deferred transaction with
`BEGIN IMMEDIATE`, which avoids a lock upgrade — so it is free or better.

**One design correction falls out of this** (§7, item 2): the cut cannot be
`Replica.lastSeq`. That only advances on replay, so a process that has just
written derives from a cut its own `lastSeq` does not yet name, and gates its own
newer derivation out. The first prototype did exactly that and left the index at
`stateBravo` for the *wrong* reason. Taking `max(lastSeq, lastAppendedSeq)` per
room fixes it, and that is the measured version above.

---

## 6. Cases 4 and 5 — two processes, one room, one hub

In-process hub (`createHub`) on an ephemeral port with a temp database; two
replica processes on one shared store, both attached.

| step | observation |
|---|---|
| created online | pending cleared, hub `connected` |
| both edit online | p1, p2 and **the hub's persisted document** all read `base p1-online p2-online` |
| hub stopped, both edit | `pending_rooms` holds the room at seq 11; both report `hub-down`; `isRoomQuiet` **false** in both |
| — | p2's replica already carries p1's offline edit: **the two processes converged through the store alone, with no hub** |
| orphan doc created offline, p1 SIGKILLed | `pending_rooms` holds the orphan at seq 12 |
| fresh p3 started, hub still down | p3 has the orphan room attached at boot (`adoptKnownDocs`/pending adoption) |
| hub restarted (same port, same database) | p2, p3 and the hub all read `base p1-online p2-online p1-offline p2-offline`; the orphan is on the hub; both pending rows cleared |

E1–E4 **pass**. The pending set was never cleared for unsent work, and
`isRoomQuiet` was false for the whole outage — `{applied, synced}` stayed honest.

Case 5, single-process baseline: document created against a dead port, process
SIGKILLed, hub started, a fresh process on the same store pushed it and the
pending row cleared. F1–F2 **pass**.

---

## 7. Scale — what eager attachment costs per process

Not a declared bar; measured because v3 §5.2 keeps every room attached in every
process and §11 lists that as a weak claim. One process, nothing to replay: the
floor every tool call pays.

| documents | rooms | boot + first settle | idle settle p50 | idle settle p95 | heap after |
|---|---|---|---|---|---|
| 30 | 33 | 16 ms | 0.19 ms | 0.25 ms | +7 MB |
| 200 | 203 | 88 ms | 1.10 ms | 1.25 ms | +17 MB |
| 1 000 | 1 003 | 826 ms | 5.33 ms | 5.75 ms | +44 MB |
| 3 000 | 3 003 | **5.36 s** | **16.35 ms** | 17.65 ms | +101 MB |

Linear, about **5.4 µs per room per settle** and, at the margin, **~30 KB of heap
(~60 KB RSS) per document**.
At today's corpus this is invisible. At 3 000 documents every tool call pays
16 ms before it does anything and a fresh process takes 5.4 s to be ready — and
`ub open`'s settle loop pays that per change, not per tool call. That is the
number phase 1b's trigger should be written against.

---

## 8. What surprised me

1. **The store constructor can refuse to open.** I expected `SQLITE_BUSY` to be
   a service-time question; it is a start-up question, and one line of ordering
   decides it. A quarter of concurrent opens failed.
2. **Contention made reads and writes *faster*, not slower,** at both realistic
   paces. Six processes on one file are cheaper per operation than one process
   doing the same mix alone, because each process carries less of the work.
3. **The single writer lock is spent on the derived index, not on the log.**
   Every long hold in the whole run was an FTS rewrite in a process that was only
   *reading*, because replaying another process's update re-indexes the whole
   document. `readSince` — the thing I expected to be the bottleneck — never
   exceeded 5 ms in 2.1 million calls.
4. **Every write is indexed twice by its own author.** 41 542 index writes for
   20 756 appends. A local write does not advance `lastSeq`, so the next settle
   reads it back out of the log and re-indexes.
5. **The `indexed_through_seq` check is free or negative.** I budgeted 1 ms of
   p95 overhead; it came in 0.06 ms *below* the current path, because
   `BEGIN IMMEDIATE` is cheaper than a deferred transaction that upgrades.
6. **The stale index is durable, not transient.** Nothing in the replica set ever
   re-derives a document that has stopped changing, so a lost race stays lost
   until somebody edits that document again.
7. **Two processes converged through the store with the hub stopped** without
   anything being designed for it — the log tail alone did it. That is v3 §5.1's
   central claim, and it is the least surprising thing here only in hindsight.

---

## 9. What v3 needs to change

1. **Fix the pragma order in `MirrorStore`'s constructor** (`busy_timeout`
   before `journal_mode = WAL`) and make it a phase-1 issue, not a phase-1b one.
   One line; 121→0 failures. Today's two-MCP-server case already hits it, so it
   is a bug fix independent of the re-cut. v3 §7 should name it.
2. **`indexed_through_seq` needs a sequence that advances on a process's own
   writes.** §5.2 says "every index write records the room-log sequence it
   derived from"; the only sequence a `Replica` exposes today (`lastSeq`) does
   not advance on local writes, so using it gates a process's own newer
   derivation out — a *worse* failure than the one being fixed, because it is
   deterministic rather than a race. The engine must remember the seq
   `appendUpdate` returned per room and derive the cut from
   `max(lastSeq, lastAppendedSeq)`. Say so in §5.2, or the issue will be written
   wrong.
3. **Make the index write, not the log, the thing §5.2 talks about.** The measured
   cost of "every writer indexing what it changes" is that *every process*
   re-indexes the whole document on every observed update: five processes ×
   ~1 300 full FTS rewrites for one document being edited, and every long lock
   hold in the run. §5.2 should either accept this explicitly with the number, or
   schedule the obvious reduction — advancing `lastSeq` on a local append, which
   removes the 2× self-re-index and is the same bookkeeping item 2 needs. Both
   are one change. It is not free of consequence and is not proven here:
   `releaseQuietRooms` and `compactLargeLogs` both read `lastSeq`, so it needs
   its own review rather than being slipped in.
4. **Give phase 1b's trigger a number.** "Memory per process is the corpus size,
   accepted on developer machines (P2) until the scale probe says otherwise" now
   has measurements: 5.4 µs per room per settle, ~30 KB heap per document, 5.4 s
   to boot at 3 000 documents. The lazy-attachment trigger should be written
   against a corpus size, not a feeling.
5. **`ub open`'s settle loop is cheap enough as designed, but it sees its own
   commits.** The `PRAGMA data_version` probe on a second connection changes when
   *any* other connection commits, including the serving process's own store
   handle, so the loop fires on its own index writes. Harmless at these sizes
   (worst iteration 110 ms, p95 11 ms), worth one sentence in §5.3 so nobody
   later reads a self-triggered loop as a bug.

Nothing here touches §5.1's or §5.2's shape. The store *is* an adequate bus for
six processes; what needs work is two lines of it and one sentence of the plan.

---

## 10. Reproduction

From `packages/mcp-server` in the worktree
(`/Users/ben/Projects/Uberblick/uberblick-crdt/.claude/worktrees/open-issues-review-3ad97f`),
with `OUT` any writable directory. Every case makes its own temp store and
ephemeral port and touches nothing else.

```sh
cd packages/mcp-server
OUT=/private/tmp/claude-501/.../scratchpad/proof1        # any directory

# Case 1 — contention (~2 min). Writes case1.json.
node --import tsx spike/proof1/case1.ts "$OUT"

# Case 1c — the open race (~1 min). Writes case1c.json.
node --import tsx spike/proof1/case1c-open-race.ts "$OUT"

# Case 1d — eager-attachment cost by corpus size (~30 s .. 5 min each).
#           Appends to case1d.jsonl.
for n in 30 200 1000 3000; do
  P1_D_DOCS=$n node --import tsx --expose-gc spike/proof1/case1d-scale.ts "$OUT"
done

# Case 2 — compaction under contention (~30 s each).
node --import tsx spike/proof1/case2.ts "$OUT"                       # 2a
P1_C2_OUT=case2b.json P1_C2_WRITES=5000 P1_C2_READER_PAUSE_MS=200 \
  P1_C2_COMPACT_DELAY_MS=300 \
  node --import tsx spike/proof1/case2.ts "$OUT"                     # 2b
P1_C2_OUT=case2c.json P1_C2_WRITES=5000 P1_C2_READER_PAUSE_MS=25 \
  P1_C2_COMPACT_DELAY_MS=300 P1_C2_WRITER_COMPACT_AFTER=100000 \
  node --import tsx spike/proof1/case2.ts "$OUT"                     # 2c — readers compact

# Case 3 — index sequencing race and the cost of the fix (~20 s). case3.json.
node --import tsx spike/proof1/case3.ts "$OUT"

# Case 4 — two processes, one store, one hub, outage and adoption (~30 s).
node --import tsx spike/proof1/case4.ts "$OUT"

# Case 5 — offline create, SIGKILL, restart, push (~15 s).
node --import tsx spike/proof1/case5.ts "$OUT"
```

Harness (all untracked, all throwaway):

| file | what it is |
|---|---|
| `spike/proof1/common.ts` | the rig: config, `TimedStore` (times every write transaction, can stall `indexDoc`/`compact`), `get_doc`/`edit_block` equivalents, `PRAGMA data_version` probe, percentiles |
| `spike/proof1/worker.ts` | case 1's child: reader / writer / serving loop / baseline |
| `spike/proof1/case1.ts` | case 1 parent: seeding, phases, visibility join |
| `spike/proof1/open-race-worker.ts`, `case1c-open-race.ts` | the barrier-released open race |
| `spike/proof1/case1d-scale.ts` | settle cost and heap by corpus size |
| `spike/proof1/case2-worker.ts`, `case2.ts` | compaction under contention with the per-read text invariant |
| `spike/proof1/sequenced-store.ts` | the `indexed_through_seq` prototype |
| `spike/proof1/case3-worker.ts`, `case3.ts` | the index race, both stores, and the cost benchmark |
| `spike/proof1/case4-worker.ts`, `case4.ts`, `case5.ts` | hub outage, adoption, offline create |

Raw results: `scratchpad/proof1/case1.json`, `case1c.json`, `case1d.jsonl`,
`case2.json`, `case2b.json`, `case2c.json`, `case3.json`, `case4.json`,
`case5.json`; declared bars in `scratchpad/proof1/BARS.md`; per-process stderr in
`scratchpad/proof1/case*-*.stderr.log`.

### Fidelity notes

- Reads and writes go through the real `Replicas` engine over the real
  `MirrorStore`, built the way `createMcpServer` builds them; only the MCP
  transport is absent. `get_doc`'s usage report into `_feedback` is not called
  (v3 §5.6 cuts that document), so the write rate here is one append per edit.
- Write latency measures the mutation; the `settle()` a real `edit_block` also
  pays is what the read column measures.
- Case 3's slow indexer stalls with `Atomics.wait` *before* the store
  transaction opens, so no lock is held across the stall; the interleaving is
  the derivation being old, not a lock being held.
- `SequencedStore` reaches the store's private `DatabaseSync` handle and restates
  the index SQL, because the gate and the row writes must share one transaction.
  That is a prototype shortcut, not a proposed patch shape; the statements and
  the transaction count are the same, so the cost measurement stands.
- Cases 3 and 4 stagger their child starts. That is a harness workaround for the
  open race in §3, not a property of the design.

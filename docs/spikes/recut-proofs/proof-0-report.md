# Proof 0 — diagnosing the #704 content loss

**Verdict for v3: STOP.**

Two independent reasons, either sufficient:

1. **The content loss is a production bug in the web editor, present today on the
   plain production path with no daemon involved.** It must be fixed first, and
   it is orthogonal to the topology re-cut (v1/v2/v3/daemon all inherit it).
2. **v3 retains every ingredient of the mechanism.** The loss is a *valid* Yjs
   update authored by the browser; v3's `beforeSync` gate is a CRDT-validity
   check and cannot reject it, and v3's "read-only while the localhost link is
   gone" rule does not fire in the remote-outage case (the localhost link is
   exactly what stays up).

The leading hypothesis in `adversary-fable-v2.md` F6 — that the daemon ran
`repairDuplicateBlocks` on a browser-created duplicate id and deleted the
original block — is **falsified**. `repairDuplicateBlocks` ran **zero** times on
the document room; there was never a duplicate id or a second element; the block
element and its `id` are untouched throughout. The loss is a **text-level
wipe inside one surviving block**, not a block deletion.

Run locally as throwaway work at `9451ad4` on macOS (darwin, arm64), Node
v26.7.0, y-prosemirror 1.3.7, yjs 13.6.32, @hocuspocus/{server,provider} 4.6.0.
Nothing was committed, pushed, or written to the live corpus or the real hub.

---

## 1. The mechanism, named

A single **browser-authored** Yjs transaction deletes the target block's entire
`Y.XmlText` — every span, from every author (the MCP creator, the agents, and
the browser itself) — and inserts only the character just typed. The block
`Y.XmlElement` and its `id` attribute survive unchanged. That update is logged
(daemon path) / relayed by the hub (production path) as an ordinary update,
applies cleanly on every replica, propagates upstream, and survives fresh-client
hydration and a page reload. The pre-outage content is gone everywhere,
permanently.

### Naming evidence — update-log replay (daemon run 1, `git`-authored ids)

Doc room `6d88d0da-…/a981c9e3-…`. Replaying the retained daemon SQLite log
update-by-update into a fresh `Y.Doc`:

```
seq=16 origin=local structs={2713544039×1("ffline-web")} deletes={}
   block e4601817  item=4234505431:5  "agent-middle-web-alpha-beta-offline-web"
seq=40 origin=local bytes=36 structs={2713544039×1("-")}
                         deletes={2713544039:0+16  4234505431:7+6,14+17}
   *** block e4601817  item=4234505431:5  -> "-"
seq=41..48 origin=local structs={2713544039×1("h"|"u"|"b"|…)}   (types out "-hub-down")
final: block e4601817 item=4234505431:5 paragraph "-hub-down-crash-durable-must-not-survive"
duplicate ids in final state: none
```

- Client `2713544039` is the browser (awareness: `client:"web"`, name
  "loitering otter"). Client `4234505431` is the daemon replica's `Y.Doc`.
- `seq=40` is one transaction: it **inserts** `"-"` (one browser struct) and its
  **delete-set covers both authors' spans** — the browser's own 16 chars
  (`0+16`) and the replica-authored `7+6` and `14+17`. That is a wholesale
  replacement of the paragraph text. `repairDuplicateBlocks` is nowhere in it;
  the block item `4234505431:5` is the same before and after.
- Run 2 is identical: `seq=40 structs={941408093×1("-")}
  deletes={941408093:0+16  3038488008:7+6,14+17}`.

### The same update on the production path (control, hub-relayed)

Doc room `…/cb931cfb-…`. The other MCP client (`Agent Beta`) receives the
destructive update straight from the hub provider:

```
seq=14 kind=remote origin=hub-provider:…/cb931cfb-…
  structs={1261264800×1("-hub-down")}
  deletes={1261264800:0+16, 2248991721:0+11, 3135783232:7+6,14+6}
  -> block e1bdd276 = "-hub-down"
```

Client `1261264800` is the browser; `2248991721` is Agent Beta; `3135783232`
is the doc's MCP creator. One browser transaction deletes all three authors'
text. `Agent Gamma`, a **fresh** `ub mcp serve` that hydrates from the hub
afterwards, reads `"-hub-down"`; the page reload reads `"-hub-down"`. Total,
global, durable loss — no daemon anywhere in this run.

### Per-step block/editor snapshots (full block list + full editor, every step)

The instrumented driver reads the whole block list and every editor child at
each step (the original harness read only `blocks[0]` and the first editor
child, which is why it could not see this). The content is intact until the
first keystroke after the hub drops:

```
12-caret-placed      web:[e1bdd276="agent-middle-web-alpha-beta-offline-web"]  status=offline
13-typed-hub-down    web:[e1bdd276="-hub-down"]                                status=offline
```

One block throughout; one id; text replaced, not the element.

---

## 2. What triggers it (observed)

Across all six reproductions the destructive edit fires under these
jointly-present conditions:

- the block's `Y.XmlText` holds text authored by **more than one Yjs client**
  (an agent's text plus the human's — uberblick's core co-editing case);
- the browser's upstream link has been **disrupted** (the hub process stopped;
  browser status reads `offline` on the direct path or `syncing…` on the daemon
  path, and the client's reconnect machinery — `dropSocket` redial in
  `packages/web/src/collab/rooms.ts` over y-prosemirror 1.3.7 — is active);
- the human then **types into that block**.

The first keystroke performs the wipe. Distinguishing facts already in the data:

- A **clean network pause** is *not* enough: in the non-skip runs the browser
  typed `-offline-web` immediately after `context.setOffline(true)` and it
  **appended correctly** (`seq` clean inserts, no delete-set). The wipe needs
  the hub to have actually gone away, not just the packets to stop.
- The **concurrent same-block agent edit is not required**: the
  `PROOF0_SKIP_CONCURRENT=1` control removed the offline/online cycle and the
  agent's same-block edit entirely; the browser stayed connected until the hub
  was stopped, then typing still wiped the multi-author block
  (`seq=23 deletes={99836539:0+16, 826507569:0+5, 3693621484:7+6,14+6}`).
- On the **daemon path the browser never lost its localhost connection**
  (status `syncing…`) and the loss still happened — so this is not merely
  "browser provider disconnected".

The delete-all-then-insert-typed shape is what y-prosemirror's `updateYFragment`
emits when the ProseMirror view's text for a block is empty/diverged from the
`Y.XmlText` at the moment of a local edit: the binding reconciles Yjs *down* to
an empty view. Why the view diverges specifically around an upstream drop is the
exact defect to pin; it lives entirely in the **stock web bundle** — I modified
no `packages/web/src` file, and the destructive update is authored by the
browser's own Yjs client. Pinning the precise y-prosemirror/`rooms.ts`
interaction is the follow-up bug's job, not Proof 0's.

---

## 3. Control run — the most important finding

**The production path loses content.** Real in-process hub, the real web app
connected directly to it, two real `ub mcp serve` processes, no daemon, no local
ingress:

| Control variant | IndexedDB | loss | duplication | fresh-client / reload |
| --- | --- | --- | --- | --- |
| production path ×2 | enabled | **yes** | no | both read `-hub-down` |
| production path ×1 | disabled | **yes** | no | both read `-hub-down` |
| no concurrent agent edit ×1 | enabled | **yes** | no | both read `-hub-down` |

- IndexedDB is **irrelevant** to the bug (loss with it on and off). v3's removal
  of IndexedDB neither causes nor fixes it.
- **No block duplication on any path** — the F6 duplicate-id path never occurred.
- This **revises the #704 spike's diagnosis.** The spike recorded the hard stop
  as "disconnecting the upstream hub erased pre-outage content from the
  still-running local authority", implying the daemon/local-authority topology.
  The control proves the erasure happens with **no daemon at all**: it is a
  pre-existing web-editor data-loss bug, misattributed to the topology.

---

## 4. What was reproduced, how many times

- **Content loss (the mechanism above): 6/6.** Daemon spike 2/2; production
  control 4/4 (IDB-on ×2, IDB-off ×1, no-concurrent ×1). Deterministic; identical
  update signature every time.
- **`repairDuplicateBlocks` involvement: 0/6.** No repairs on the doc room, no
  duplicate ids, no block deletion. Hypothesis F6 falsified.
- **Daemon-only secondary hard stop (refused-append propagation, spike's other
  finding): 1/2** (run 1 the refused mutation reached the hub and returned after
  restart; run 2 it did not) — nondeterministic, matching the merged spike
  report. Daemon-specific (Yjs observer ordering under the daemon), not on the
  production path; not the focus of Proof 0.

---

## 5. Exact reproduction commands

```sh
# worktree at the harness commit (from the main worktree)
git -C <main-worktree> worktree add --detach <scratch>/proof0-worktree \
    9451ad4eca332c5b7e7c4c5f49d9ffd9702d14b9
cd <scratch>/proof0-worktree && mise trust && mise run install

# instrumented daemon spike (keeps daemon+hub DBs and trace.jsonl under the dir)
PROOF0_KEEP_DIR=<scratch>/proof0/runs mise run proof0-daemon

# production-path control (no daemon); variants:
PROOF0_KEEP_DIR=<scratch>/proof0/runs mise run proof0-control                     # IDB on
PROOF0_NO_IDB=1        PROOF0_KEEP_DIR=<scratch>/proof0/runs mise run proof0-control
PROOF0_SKIP_CONCURRENT=1 PROOF0_KEEP_DIR=<scratch>/proof0/runs mise run proof0-control

# name the destructive update from a kept daemon store
mise exec -- pnpm --filter @uberblick/mcp-server exec tsx \
    spike/proof0-replay.ts <run-dir>/daemon.sqlite <workspace>/<docUuid>

# condense a run's trace to the step snapshots + repair/update lines
python3 <scratch>/proof0/analyze-trace.py <run-dir>/trace.jsonl
```

`mise run proof0-daemon` runs `PROOF0_TRACE=1` end to end (the driver forces it),
retains the daemon SQLite DB (the `rmSync` is skipped when `PROOF0_KEEP_DIR` is
set), and prints its path. The instrumentation is trace-only (`PROOF0_TRACE`
guards it); with the flag unset the spike behaves as the original.

---

## 6. Does v3's `ub open` keep any ingredient? Yes — specifically.

**The `beforeSync` gate (v3 §5.3) cannot stop it.** The plan says `beforeSync`
"validates [update bytes] by applying to a scratch `Y.Doc`, and only then appends
them to the store … A payload the scratch document rejects is refused before
anything is stored." The destructive update is a **well-formed** Yjs update — a
delete-set plus an insert — and applies to a scratch `Y.Doc` without error. The
gate passes it, appends it as local-origin, applies/acks/broadcasts it, and the
replica half forwards it upstream. A CRDT-validity gate cannot tell "the human
deleted the block text and typed a character" from "the binding erroneously
rewrote the block"; both are valid deletes. Gate: **no defense.**

**The read-only-while-disconnected rule (v3 §5.4) does not fire.** v3 makes the
editor read-only only "whenever its room has no live localhost connection or was
refused." In the remote-hub-outage case the browser's **localhost** link to
`ub open` stays up (that is v3's whole offline-editing premise); only the remote
hub is down. So the editor stays editable and the user keeps typing — and the
Proof 0 daemon runs already show the wipe happening while the browser's local
link was live (`syncing…`). Read-only rule: **not triggered.**

**The two-document bridge (v3 §5.3 / §7) reproduces the daemon's exact shape.**
`ub open` is architecturally the daemon: browser ↔ localhost Hocuspocus ingress ↔
store ↔ upstream hub. The Proof 0 daemon reproduced the loss 2/2 in precisely
that shape. Nothing in v3 changes the browser, which is where the destructive
update is authored.

Net: v3 would ship the loss unchanged, and — because the bug is already live on
today's direct browser↔hub path — so does the status quo. That is the STOP.

---

## 7. Change v3 needs

1. **Add a phase-0 blocker: fix the web-editor content wipe before any topology
   work.** File it through `.github/ISSUE_SPEC.md`'s Request-source path as a P1
   data-loss bug against the web client (y-prosemirror 1.3.7 binding +
   `collab/rooms.ts` `dropSocket` reconnect), not against the hub or `ub open`.
   Its acceptance criterion is the Proof 0 control scenario: with a
   multi-author block, stop the hub, type, restart the hub — no author's text is
   lost, on the direct path and through `ub open`. Repro harness:
   `packages/web/e2e/proof0-control.ts` at this worktree (throwaway).
2. **Do not rely on `beforeSync` for content safety.** v3 §7 and §11 claim 1/9
   treat the gate as the correctness seam; state explicitly that it guarantees
   *replay-safety* (no malformed frame poisons the log), **not** content
   preservation — a semantically destructive but well-formed update passes it.
   A content-loss defense, if wanted, is a separate mechanism (e.g. server-side
   detection of a single update that deletes across multiple client ids while
   inserting little, or editor-level guards), and belongs to the web-editor bug,
   not the gate.
3. **Correct the record.** The #704 hard stop "upstream disconnect erased
   pre-outage content from the still-running local authority" is a **web-editor
   bug reproducible with no daemon**, not evidence against the daemon/local-
   authority topology. Update Topology decision parameters / the spike note so
   the topology decision is not made on a misattributed hard stop. (The daemon's
   *other*, nondeterministic hard stop — a refused append still reaching the hub
   — is genuinely daemon-specific and remains a separate mark against that
   specific candidate.)

---

## 8. Instrumentation and artifacts

Worktree-only, all under `<scratch>/proof0-worktree` (removed — see below):

- `packages/mcp-server/src/proof0-trace.ts` — trace helpers: `rawBlocks`
  (every element incl. shadowed, with Yjs item id), `describeUpdate`
  (decodeUpdate → structs by creating client + delete-set), origin describer.
  Guarded by `PROOF0_TRACE`.
- `packages/mcp-server/src/replica.ts` — trace hooks in the update observer,
  `poll`/replay, and `repairDuplicates` (logs every repair with before/after);
  behaviour unchanged when `PROOF0_TRACE` unset.
- `packages/mcp-server/spike/daemon-authority-daemon.ts` — ingress
  connect/disconnect/load/unload and bridge attach/sync/close trace hooks.
- `packages/mcp-server/spike/proof0-replay.ts` — replays a room's `updates`
  (+`snapshots`) from a MirrorStore DB via `node:sqlite`, naming per-update
  removals/additions and the delete-set's covering client.
- `packages/web/e2e/proof0-daemon-spike.ts` — the #704 driver, instrumented to
  read the full block list + full editor at every step, keep the daemon DB
  (`PROOF0_KEEP_DIR`), and forward child P0 lines into one `trace.jsonl`.
- `packages/web/e2e/proof0-control.ts` — production-path control (real hub, real
  web app, two real `ub mcp serve`), reusing the same helpers; `PROOF0_NO_IDB`,
  `PROOF0_SKIP_CONCURRENT` flags.
- `mise.toml` — `proof0-daemon`, `proof0-control`, `proof0-replay` tasks.

Kept run artifacts (isolated temp DBs, ephemeral ports) under
`<scratch>/proof0/runs/` (daemon-run-*, control-run-*) and the analyzer at
`<scratch>/proof0/analyze-trace.py`.

**The worktree was removed** with `git worktree remove --force` from the main
worktree after the runs, so it does not linger. Because that deletes the
instrumented code, it is preserved for reproduction under
`<scratch>/proof0/instrumentation/`:

- `tracked-changes.patch` — the diff against `9451ad4` for `mise.toml`,
  `packages/mcp-server/src/replica.ts`,
  `packages/mcp-server/spike/daemon-authority-daemon.ts` (apply with
  `git apply` in a fresh worktree at that commit);
- `new-files/…` — the four new files (`proof0-trace.ts`, `proof0-replay.ts`,
  `proof0-daemon-spike.ts`, `proof0-control.ts`) at their package-relative
  paths; copy them in before running the tasks.

To reproduce after the worktree removal: recreate the worktree at `9451ad4`
(§5), `git apply <scratch>/proof0/instrumentation/tracked-changes.patch`, copy
the `new-files/packages/**` files into place, then `mise run install` and the
tasks in §5. The run artifacts (`daemon-run-*`, `control-run-*`) and analyzer
under `<scratch>/proof0/` remain for inspection without rerunning.

# Shared workspace owner spike — result

Issue: #621. Measured 2026-09-02 against `origin/main` at `0d97f2f`.

## Recommendation

**No-go on shipping a serving workspace owner now.** One process can own the
existing update log, replicas, hub connection, and derived index while both a
web-like loopback client and an MCP-like client use it. The prototype preserved
offline durability, Yjs merging, remote convergence, and the narrow meaning of
`synced`. It also collapsed both clients into the owner's one awareness
identity. That is the explicit no-go in #621 and the missing precondition in
Topology decision parameters (`8d148677-93cc-4e7a-953f-67c65b77598f`).

Keep the plain star. If a backlinks UI becomes scheduled, prefer the smaller
sequence: revive the non-serving full-corpus sync/index sidecar behind its
completeness decision, then put an authenticated, read-only, same-origin
backlinks endpoint in front of that index. A narrow read service over today's
shared WAL without a persistent full-corpus owner must report itself incomplete;
otherwise its index can be quietly stale whenever no MCP process has attached a
room.

This spike changes no production topology, schema, CLI, MCP interface, or
persisted data.

## Reproduce

Run:

```sh
mise run spike-shared-owner
```

The task creates a private temporary directory, starts a real hub and one real
`createMcpServer` owner, exercises both transports, prints one JSON result, and
removes its databases, lock, socket, and providers. Any failed invariant exits
non-zero instead of printing a partial success record.

## Current and candidate data flow

Today:

```text
browser Y.Doc + IndexedDB ───────────────┐
                                        ├─ remote hub
MCP process A: Replicas + WAL + index ──┤
MCP process B: Replicas + same WAL + index
```

Each MCP process opens the same WAL database safely, but owns a separate
`Replicas`, provider set, hub settlement loop, and index-repair work. The browser
owns different Y.Docs in IndexedDB, talks directly to the hub, and has no
corpus-wide backlink index.

The disposable candidate:

```text
web-like Y.Doc ─ loopback HTTP update ─┐
                                      ├─ one owner: Replicas + WAL + index ─ hub
MCP-like client ─ in-memory MCP ───────┘
local process ─ permissioned IPC read ─┘
```

Only the owner opens `MirrorStore`; neither client can write the derived SQLite
tables. The web-like path exchanges Yjs updates rather than document JSON. The
MCP-like path uses the real tool handlers. Both reads settle the same owner and
query its one backlink index.

## Evidence

The declared fixture was Linux x64, Node 26.7.0, one workspace, three documents,
one web-like loopback Y.Doc, one MCP in-memory client, one real SQLite owner
database, and one real Hocuspocus hub database. Transport latency used 30
backlink reads per path. Hub and owner ran in the measuring process, so RSS is a
comparison point, not a production capacity number.

| Probe | Result |
| --- | --- |
| MCP creates an inline link; web reads backlinks | same source returned from the owner's index |
| Web sends an inline-link Yjs update; MCP reads backlinks | both sources returned from that index |
| Simultaneous web/MCP backlink reads | byte-equivalent JSON answers |
| Concurrent clients | edits prepared from one snapshot on different blocks both survived the Yjs merge |
| Hub down, local write | `{applied: true, synced: false}` |
| Owner restart while hub remains down | the merged state and offline edit were read from the authoritative log |
| Hub restart and independent replica | the separate hub-connected Y.Doc received the merged offline state |
| Second owner for the workspace | refused as `owner-already-running` by the disposable ownership lock |
| Wrong loopback credential | `401 unauthorized`, never a local success |
| Protocol mismatch | `426 protocol-incompatible`, with both protocol versions |
| Owner stopped | connection refused, distinct from protocol or hub state |
| Awareness | one `client: agent` / owner session; the web-like client had no distinct presence |

One representative run reported:

| Measurement | Result |
| --- | ---: |
| Empty-database cold start | 82.502 ms |
| Hub-down owner restart | 521.701 ms (includes the configured 500 ms connection grace) |
| Loopback HTTP backlink median / p95 | 0.612 / 0.986 ms |
| Unix-socket backlink median / p95 | 0.301 / 0.499 ms |
| Hub restart to remote replica receiving the offline edit | 178.063 ms |
| Hub restart to owner reporting acknowledgement | 184.438 ms |
| Whole measuring process RSS | 163,868,672 bytes |

The two recovery waits start together after the restarted hub has bound. The
JSON output remains the timing authority: the table is one representative run,
not a performance budget.

## Identity, status, and failure boundaries

The content path is feasible; identity forwarding is not present. `Replicas`
owns one `sessionId`, one agent name, and one local awareness state. A web-like
update applied by that owner is durable and mergeable, but peers attribute the
owner, not the originating client. Adding a client name to the HTTP request
would only make the claim self-asserted; it would not create distinct Yjs client
awareness lifecycles, withdrawal, cursor ownership, or future credential-derived
identity. Shipping that shape would make identity collapse permanent, so the
result is a no-go rather than a recommendation to add a field.

The prototype reports remote synchronization only from the owner's configured
hub state. Accepting and logging a local update yields `applied: true`; while the
hub is down it yields `synced: false`. Owner unavailable, owner protocol skew,
owner authentication failure, hub unavailable, and a locally applied but
unacknowledged update are five distinct readings.

The candidate keeps a complete local replica and therefore does not settle the
completeness gate banked in #395. Moving full-corpus attachment into one process
removes duplicate work; it does not define how a later active-document model
keeps search/backlinks complete or signals that it cannot.

## Transport and security comparison

Loopback HTTP is the only candidate a browser can use. It should be routed below
the existing `ub open` origin; opening a second origin recreates endpoint
confusion and requires a CORS policy. Loopback is not authentication: a website
can send blind requests to local addresses. A production route would need an
unexported owner credential, a non-simple authenticated request, strict origin
checking, request bounds, and no root hub secret in the bundle or response.

A Unix-domain socket was about 0.3 ms faster at this fixture, but a browser
cannot open it. Mode `0600` separates OS users, not arbitrary processes already
running as the owner, so the prototype also requires its bearer credential. IPC
is a reasonable internal hop behind the stable `ub mcp serve` stdio front door;
the sub-millisecond difference is not a topology decision.

## Ownership and lifecycle

One process per workspace is the simpler initial ownership unit: the existing
configuration, database claim, credential, pending-room set, diagnostics, and
failure quarantine are all workspace-scoped. It also contains a crash and an
upgrade to one corpus. A many-workspace process could amortize the measured RSS,
but would need credential routing, per-workspace drain/upgrade state, partial
failure isolation, and a rule for one busy workspace not delaying the others.
No evidence here justifies that machinery.

- **Start:** a supervisor acquires one workspace ownership record before opening
  SQLite or listeners. The disposable `wx` file proves exclusion only; a real
  design needs crash-safe holder detection rather than treating a stale file as
  a live owner.
- **Idle:** a full-corpus sync/index owner cannot shut down merely because no
  client is attached; doing so gives up the freshness it exists to supply. A
  serving-only owner may drain after a grace period only when there are no
  clients and no pending rooms.
- **Upgrade:** refuse protocol skew, stop admission, drain local writes through
  the configured hub when possible, close the log, replace the process, and let
  the new owner replay the same log. Never silently fall back to a second owner.
- **Diagnostics:** the prototype returns protocol version, workspace, hub state,
  pending-room count, and PID. It returns no token, database path, document, room,
  environment, or configuration contents.

## Candidate comparison

| Shape | Shared index / browser backlinks | Identity and sync | Cost / verdict |
| --- | --- | --- | --- |
| Today's shared-WAL MCP processes | index is local to each process; browser has none | distinct MCP and web awareness; current honest hub status | zero new machinery; keep |
| Serving owner prototype | yes, and web writes merge through one durable owner | remote-sync claim stayed honest; awareness collapsed | technically feasible, **no-go now** |
| Banked non-serving sidecar (#395) | keeps one full-corpus index fresh, but serves no browser itself | MCP/web providers remain distinct; completeness mechanism still required | lower topology risk; revive only at its recorded trigger |
| Narrow read service | exposes backlinks without moving writes | preserves client writers/identity | smallest UI enabler, but must be sidecar-backed or disclose incomplete results |

The prototype does not overturn the plain-star decision in Sync topology
(`37345bf0-aa04-4fe0-9f25-e36551974fe4`) or the serving-application evidence
gate in Topology decision parameters. It confirms Architecture
(`d2d28f20-7c9a-4547-b65b-0fdf75a41dff`): the append-only log remains the
authoritative local replica and the index remains derived. Deferred designs and
their triggers (`435d453a-5bf2-46aa-b84a-e14959133032`) remains the authority
for reviving the non-serving sidecar.

## Independently deliverable slices

1. **S — result contract (this spike):** disposable owner, failure readings,
   timing fixture, and this recommendation. No production behavior.
2. **L — non-serving sidecar and completeness status:** one persistent
   full-corpus replica/index owner, every persisted room exchanged on endpoint
   change, and an explicit complete/incomplete state. This is the #395 revival,
   not implied authorization from this spike.
3. **M — authenticated read-only local service:** versioned diagnostics plus
   search/backlinks over a sidecar-owned index, same-origin HTTP for the browser
   and IPC behind `ub mcp serve`; no write forwarding.
4. **M — backlinks UI:** consume the read service, show incomplete/unavailable/
   incompatible states, and keep document editing on the existing web provider.
5. **L — multi-client write and awareness forwarding:** durable per-client Yjs
   update sessions, distinct awareness/cursor withdrawal, credential-derived
   identity, and client-specific acknowledgement. Blocked by the identity
   no-go; not a follow-on to schedule by default.
6. **L — installed lifecycle:** supervisor, crash-safe ownership, idle/drain,
   upgrades, diagnostics, and CLI control. The superseded #250/#251 inventories
   remain useful, but their packaged daemon design is not revived here.

For a future backlinks UI, slices 2–4 are the smallest honest path. Slice 3 by
itself is useful only if it reports the index's incompleteness; slices 5–6 are
not prerequisites for read-only backlinks and should remain unscheduled.

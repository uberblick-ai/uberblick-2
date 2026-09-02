# Per-machine daemon authority spike (#704)

## Verdict

Do not adopt this candidate.

The experiment proves that one per-machine process can serve the real web app
and two real `ub mcp serve` processes while it alone owns the local SQLite log
and the upstream hub connection. Content, three distinct awareness identities,
cursors, and per-session departure all crossed that boundary.

It also hit a predeclared lifecycle hard stop in both complete runs: stopping
the upstream hub erased the pre-outage block content from the still-running
local authority. A forced local log refusal exposed a second race in one of the
two runs: the tool returned `applied: false`, but the rejected in-memory update
had already propagated upstream and reappeared after restart. Cold start also
missed its provisional bar in both runs.

This is evidence about the tested topology, not a language, packaging, or
service-manager recommendation.

## Reproduction artifact

The disposable implementation and driver are intentionally unmerged. They are
pushed on `spike/704-daemon-authority-harness` at commit
[`9451ad4eca332c5b7e7c4c5f49d9ffd9702d14b9`](https://github.com/uberblick-ai/uberblick-2/commit/9451ad4eca332c5b7e7c4c5f49d9ffd9702d14b9).
To reproduce from that exact artifact:

```sh
git switch --detach 9451ad4eca332c5b7e7c4c5f49d9ffd9702d14b9
mise run install
mise run spike-daemon-authority
```

The branch also passes `mise run lint`, `mise run typecheck`, and
`mise run test`. The experiment was run twice to completion on 2026-09-02 on
Linux x64 with Node v26.7.0. Each run created isolated temporary databases,
ports, and a Unix socket and removed them afterward.

## Candidate boundary

The candidate kept the current `MirrorStore`, `Replicas`, MCP tools, web app,
and upstream hub protocol. It added only disposable seams:

1. A daemon owns one `MirrorStore`, one shared `Replicas` registry, and the
   remote Hocuspocus provider.
2. A loopback Hocuspocus ingress bridges the unchanged web app into those
   daemon-owned Yjs documents. The browser's `indexedDB` is disabled before any
   app code runs, and its configured hub URL is the loopback ingress.
3. Each real `ub mcp serve` process keeps its normal stdio JSON-RPC boundary but
   forwards bytes over a Unix socket. The daemon creates one real `McpServer`
   session per socket while sharing document state.
4. Each MCP session uses a separate synthetic awareness client ID, name, color,
   cursor, and departure update. The daemon itself publishes no user identity.
5. The loopback ingress checks the one expected browser Origin and verifies the
   existing room credential. This was enough to exercise the boundary, not a
   complete local authorization design.

Before failure injection, the upstream hub logged exactly one connected socket
ID for the daemon. `/proc` descriptor inspection found no SQLite or database
handle in either `ub mcp serve` process tree. The browser reported
`typeof indexedDB === "undefined"`. Together with the browser's loopback URL,
those checks establish that the three clients did not open the local database
or an upstream hub connection in this fixture.

## Real-client result

The browser wrote content that an MCP client read, and an MCP client wrote
content and a cursor that the browser rendered. Upstream awareness contained
three distinct client IDs in both runs: Agent Alpha, Agent Beta, and the web
user. Both agent cursor labels were visible simultaneously. Closing Alpha
removed only Alpha; Beta and the web user remained upstream.

The browser and Beta then edited the same block while the browser was offline.
After reconnect, both read the same merged value:

```text
agent-middle-web-alpha-beta-offline-web
```

This proves the content and identity path under ordinary operation. It does
not overcome the lifecycle failures below.

## Failure matrix

| Case | Web reading | MCP reading | Daemon / durable reading | Result |
| --- | --- | --- | --- | --- |
| Graceful daemon restart | Changed to `syncing…`, then reconnected | Existing real `ub mcp serve` exited; a newly started process read the current value | Local log reopened with the current post-outage value; restart took 478 ms / 566 ms | Dependency boundary was visible and current logged state recovered |
| Crash after append, before reply | Reconnected after the daemon returned | Caller lost the reply when its proxy ended | Daemon died by `SIGKILL`; the edit ending in `-crash-durable` was present after restart | `applied` remained tied to the synchronous daemon log, but the caller correctly had an ambiguous outcome |
| Daemon down at client start | Not applicable | Real `ub mcp serve` exited 1 with `daemon unavailable` and the Unix-socket `ENOENT` | No fallback database or hub owner started | Clear refused start |
| Upstream hub outage and reconnect | Reported `syncing…`, not `synced` | `sync_status` reported `hub-down` with two pending rooms | Expected `agent-middle-web-alpha-beta-offline-web-hub-down`; local and upstream state instead became `-hub-down` in both runs | **Hard stop: pre-outage content loss** |
| Concurrent same-block edit | Read the converged merged value | Read the same merged value with the agent prefix and offline web suffix | Same value reached the authority before failure injection | Passed |
| Forced daemon-log refusal | Continued through the shared in-memory document | Tool returned `applied: false`, `synced: false`, `persistence_failed` | Rejected text was absent after restart in one run but had propagated and returned in the other | **Hard stop: nondeterministic false-negative application** |

The daemon restart probe happened after the upstream-outage probe. It therefore
shows that the daemon preserves its then-current log, not that it recovered the
content already lost during the hub outage.

The browser's observed `syncing…` state avoids a false `synced` claim in these
two schedules. It does not prove the current end-to-end meaning of `synced` for
the topology: the unchanged browser protocol has only the local Hocuspocus
acknowledgement and receives no durable upstream watermark from the daemon.
That missing composite acknowledgement remains an unproven requirement even
without the observed content-loss hard stop.

## Provisional bars

The bars were declared on the issue before the candidate ran. Values below are
the two complete runs in order; latency values are milliseconds and memory
values are bytes.

| Measure | Declared bar | Run 1 | Run 2 | Result |
| --- | --- | ---: | ---: | --- |
| Cold start | `<= 200 ms` | 477.638 | 426.579 | Fail both |
| Daemon idle RSS | `<= max(1.5 × direct, direct + 40 MiB)` | direct 274251776; limit 411377664; daemon 139120640 | direct 268427264; limit 402640896; daemon 131870720 | Pass both |
| `edit_block` median, 20 samples | `<= max(2 × direct, direct + 2 ms)` | direct 1.803; limit 3.803; daemon 2.479 | direct 3.305; limit 6.610; daemon 3.823 | Pass both |
| `edit_block` p95, 20 samples | `<= max(3 × direct, direct + 10 ms)` | direct 4.152; limit 14.152; daemon 5.017 | direct 6.928; limit 20.784; daemon 9.627 | Pass both |
| Remote reconnect | `<= 1000 ms` | 122.280 | 67.472 | Pass both |
| Offline edit visible upstream after reconnect | `<= 1000 ms` | 1.495 | 1.525 | Pass both |

The RSS comparison follows the predeclared process-alone rule: the direct
baseline is one direct `ub mcp serve` process tree, and the candidate is the
idle daemon process tree without its thin client processes. These are
single-host directional measurements, not capacity estimates.

## Proven, unproven, and gaps

Proven by the harness:

- one daemon can be the sole SQLite and upstream-socket owner for a real web
  client and two real stdio MCP client processes;
- the daemon can multiplex distinct MCP awareness identities and withdraw one
  without withdrawing another;
- ordinary browser/MCP edits and a disconnected same-block conflict converge;
- a synchronously appended edit survives a crash before its JSON-RPC reply;
- clients surface daemon loss rather than silently starting another authority;
- steady-state edit latency, idle RSS, reconnect, and propagation met their
  provisional bars on this host.

Not proven, or disproven by this candidate:

- upstream disconnect safety is disproven by repeatable pre-outage content
  loss;
- strict log-before-publish ordering is disproven by one refusal run and is
  nondeterministic under the candidate's Yjs observer ordering;
- cold start misses the provisional bar;
- the browser has no explicit daemon-to-upstream durable watermark, so the
  current meaning of `synced` is not established for every schedule;
- no production-quality peer authorization, Unix-socket permission policy,
  credential isolation, multi-workspace policy, upgrade handoff, or automatic
  client restart was built;
- Windows/macOS IPC, suspend/resume, machine reboot, service supervision,
  version skew, long-lived compaction, and multi-user machines were not tested;
- twenty edits on one Linux host are insufficient for a capacity conclusion.

## Hard stop and remaining design work

The topology should not advance from this spike. A future, separately shaped
candidate would first need to make the daemon's durable local append the only
publication point, prevent an upstream provider lifecycle event from replacing
or clearing locally authoritative state, and expose a durable upstream
watermark/composite status to every client. It would then need to repeat this
same failure matrix before service lifecycle or distribution work is useful.

This report intentionally makes no language, packaging, distribution, or
service-manager recommendation.

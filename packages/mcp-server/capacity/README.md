# MCP host capacity measurement

An opt-in Linux experiment, outside the test suite and CI. Run from the repository
root after `mise run install`. Choose a **new** directory on a volume with at least
6 GiB free; it holds synthetic credentials, hub data, mirrors and private logs.

```sh
mise exec -- pnpm --filter @uberblick/mcp-server exec node --import tsx capacity/run.ts all /absolute/private/new-run
```

Replace `all` with `memory`, `cap`, `restart` or `cold` to rerun one scenario with
its preparation. An optional last argument selects a smaller runtime cap (1–32)
for investigating a deployment that cannot fit the default. Every invocation
starts fresh, seeds its own hub and ends all its child processes. The overall
deadline is 20 minutes; service children also have deadlines. This is a benchmark,
so the normal 60-second test budget does not apply.

The unchanged `packages/hub/src/main.ts` and `capacity/host.ts` run in separate
Node processes. The parent generates load and samples Linux `/proc` every 100 ms.
RSS includes worker threads; VmHWM also captures peaks between samples. CPU is
process user plus system time, with 100% meaning one core. File counts include
sockets and worker descriptors. Disk reports both apparent and allocated bytes
for every file under `mirrors`, including SQLite journals and history caches.
The generator/client and fixture preparation are excluded from host/hub memory.
VmHWM covers a process's full lifetime; sampled phase RSS gives the hub's
restart-specific peak, since the hub stays running between phases.

The hub binds an ephemeral port on `0.0.0.0` to select its existing device
credential admission; requests use loopback. Run on an isolated benchmark host.
There is no container, proxy or TLS. The MCP host uses production runtimes,
sessions, capacity admission, synchronization, SQLite, search and history workers.
Its test-only token checker accepts fixture grants, and its injected credential
provider returns seeded device credentials. OAuth introspection, hosted grant-key
issuance/renewal and the production Ed25519 grant admission path are omitted.
Actual device room authentication remains enabled on the hub. No selector or
test admission code is added to production source or the released host bundle.

The deterministic shape is four workspaces with 200 documents each. Each has
120 × 1 KiB, 50 × 4 KiB, 25 × 16 KiB and 5 × 64 KiB of visible prose/list/code
text. The size mix is an engineering reference profile, not a sample of private
user data or a universal capacity promise. The classes receive 20, 100, 500 and
500 edit transactions, grouped into 10, 20, 50 and 50 real hub revision stretches.
Edits replace 64 characters at varying positions; fixture construction retains
deleted content, then the production hub's normal Yjs GC preserves the resulting
structural history. The profile reports both encodings and the retained structs.
Eight synthetic people appear as historical editors. One active principal has
32 independent grants, eight per workspace; a further unused grant probes an
empty mirror. Each grant has its own injected device credential. This distribution
does not measure many-account credential-store behavior.

`memory` records the baseline and each additional searchable runtime, allowing
one second for worker startup before its resource checkpoint. It also records
downloaded history catalog/snapshot counts. The delivered host does not propagate
the injected grant login or storage configuration to the background history
refresher; snapshots are not downloaded in this experiment. The live documents
still contain their full retained CRDT structural history, and actual worker RSS
and polling costs remain included. Recalibrate after that history path changes.
`cap` opens all 128 sessions and submits ten waves of 64
concurrent calls: 48 searches and 16 acknowledged metadata writes per wave,
rotating writes across all workspaces. Latencies include hub acknowledgement.
`restart` gracefully stops the host, keeps every mirror, starts a fresh process
and starts 128 new client sessions across all 32 grants together. It reports time from process spawn
until every grant is searchable, including listener startup. `cold` measures
first request through complete search for one unused grant and one kept mirror,
each in a fresh host process. HTTP 503 counts are recorded by phase; unexpected
transport/tool failures fail the run and appear in `findings`.
Search readiness retries HTTP 503 after the host's one-second Retry-After;
writes are never retried by the harness.

Search has a 100-hit maximum and no pagination. Two body-only marker queries,
each with an exact expected set of 100 UUIDs, prove that every document is indexed;
listing or matching titles alone is insufficient. Cold/restart completion means
search completeness. Background snapshot downloads are a disclosed limitation,
not part of the readiness definition.

`results.json` contains revision, machine, profile, checkpoints, latency summaries,
peaks, refusals and findings. `samples.json` contains the time series. These files
contain no document content or credentials and can be published after inspection.
Keep `fixture.json`, login stores, databases and service logs private. Remove the
whole output directory after preserving the public results.

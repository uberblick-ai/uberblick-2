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
These processes run TypeScript through `tsx`; loader/module overhead is included,
so these are source-mode measurements rather than a packaged-image footprint.
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
`cap` opens all 128 sessions and submits ten waves at the configured call cap:
75% searches and 25% metadata writes per wave,
rotating writes across all workspaces. Latencies include the host's bounded
acknowledgement wait; acknowledged and still-unsynced writes are counted separately.
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
An empty mirror does not imply an empty OS page cache; this harness does not
flush kernel caches. Results are single runs on the named machine.

`results.json` contains revision, machine, profile, checkpoints, latency summaries,
peaks, refusals and findings. `samples.json` contains the time series. These files
contain no document content or credentials and can be published after inspection.
Keep `fixture.json`, login stores, databases and service logs private. Remove the
whole output directory after preserving the public results.

## Reference results and defaults

The [reference run](reference-results.json) measured commit
`b1a569c0e2734cc577e3dac9ba6c5d6e2e2b7716`; the
[64-call baseline](baseline-64-calls.json) measured
`77306c38f9b34c467c80c3087a250129d8e8e05e`. Both completed all four scenarios
without unexpected failures or HTTP 503 responses. Later changes in this
directory only record those results and their interpretation.

Machine: an x86_64 KVM VM with eight AMD EPYC-Genoa vCPUs, 15.24 GiB RAM,
Ubuntu 26.04.1 LTS, Linux 7.0.0-38-generic and Node v26.13.0. The data volume
is a 9.8 GiB Linux block volume; actual process open-file limits were 524,288.
The reference deployment uses that machine class and data volume, with planning
budgets of 4 GiB host RSS, 2 GiB hub RSS, 2 GiB active mirrors and 2,048 host
descriptors. These budgets were compared with observed use, not enforced as
container quotas. The remaining memory and disk allow for the OS and other hub
state. Storage latency materially affects these results.

At 32 searchable runtimes, host RSS was 1.56 GiB. The aggregate increase over the
empty host was **44.79 MiB per runtime**, with a median individual increment of
44.58 MiB. Individual increments ranged from −49.95 to 106.17 MiB as GC and the
allocator moved RSS; the JSON retains every checkpoint. Allocated mirror storage
averaged **10.54 MiB per runtime**, including journals, with about **17 additional
open descriptors** and five mirror files. The earlier spike reported 5–6 MB for
50 small history-free documents and 10–17 MB for 200, with the hub sharing its
process. This run includes workers, retained edit structures and source loaders.

| At-cap measurement | 64-call baseline | 16-call reference |
| --- | ---: | ---: |
| Sessions / runtimes | 128 / 32 | 128 / 32 |
| Search calls / metadata writes | 480 / 160 | 120 / 40 |
| Search p50 / p95 | 2.357 / 32.724 s | 0.783 / 6.582 s |
| Write p50 / p95 | 10.804 / 28.432 s | 3.961 / 5.432 s |
| Acknowledged / still-unsynced writes | 82 / 78 | 28 / 12 |
| Host CPU, 100% = one core | 46.37% | 48.51% |
| Hub CPU, 100% = one core | 3.19% | 3.43% |

The reference's at-cap host peak was 1.62 GiB RSS and 688 descriptors; the hub
peak was 282.55 MiB RSS. Allocated mirror storage after load was 339.96 MiB.
The lower ceiling reduces batch latency and the proportion of bounded unsynced
answers; it does not remove them. The benchmark submits ten waves at each
ceiling, so total request counts differ; it does not establish a fixed-arrival
throughput or latency guarantee.

Restarting the host with every mirror kept, then reconnecting all 128 clients,
took **29.523 s** until all clients could search every document, including
0.544 s listener startup. Peak host RSS was **2.112 GiB**, hub RSS **310.74 MiB**,
and host descriptors 701. There were zero 503 refusals and no other failures.
Cold first-request-to-complete-search was **8.220 s empty**, **1.182 s kept**.

| Default | Selection from these results |
| --- | --- |
| 32 open runtimes | Retained: all 32, including restart, fit the 4 GiB host / 2 GiB hub RSS and 2 GiB mirror budgets. |
| 128 open sessions | Retained: the at-cap load and complete client restart stayed below the 2,048-descriptor budget, with measured peak 701. |
| 16 calls in progress | Reduced from 64: the at-cap comparison lowered search/write p95 from 32.72/28.43 s to 6.58/5.43 s and unsynced-write proportion from 48.75% to 30%. |
| 256 MiB free-space admission floor | Retained: over 24 times the measured mean incremental mirror size, with ample free space on the reference volume. This existing floor gates new runtimes; it is not an ongoing growth quota. Near-full eviction behavior was not capacity-tested. |

The profile retains 55,760 CRDT structures, 22,400 edit transactions and 3,700 hub
revision stretches per workspace. **Downloaded history catalogs and snapshots
were zero** in both runs. The hosted history credential/storage gap is tracked
in [the follow-up](https://github.com/uberblick-ai/uberblick-2/issues/2640);
recalibrate these defaults when that path works. The repeated synthetic prose
also has less vocabulary diversity than a real corpus. The named profile and
omitted admission/packaging costs limit how far these figures generalize.

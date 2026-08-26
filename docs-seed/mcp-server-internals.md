---
uuid: 06777f59-3159-4511-8236-8fc66d70da27
title: MCP server internals
tags: [implementation-reference]
links: [bea0f13c-5ba9-4fb6-af7b-d627b4807786, 9b4ea859-8304-4e11-9cc8-76232c16a4e5, 8a070124-2dc6-442a-8ea9-6db5b63ca950, e6609049-7917-42ac-8ab3-f068aed2a707]
---

How the MCP server holds data, what `applied` and `synced` each guarantee, and
where the fail-stop is. Source is `packages/mcp-server/src`.

## Boot, and why it needs no network

`createMcpServer` awaits nothing: it opens the store, constructs the replica
set — which attaches `_directory`, `_sidebar` and every room the pending
watermark names — and registers the tools. The hub connection happens in the
background. Every tool serves with no hub configured, no hub running and no
network at all.

## The store

Node's built-in `node:sqlite`, at `UBERBLICK_DB` or, by default,
`<data home>/uberblick/<workspace-uuid>.sqlite` — keyed by the bare uuid, so a
decorated spelling hydrates the same file. WAL, a five-second busy timeout and
foreign keys on: two server instances over one database is the normal case.

Authoritative tables:

- `updates` — the append-only log: sequence, room, payload blob, origin. SQLite serialises writers, so sequence order is commit order.
- `snapshots` — one compacted state per room, with the sequence it covers.
- `pending_rooms` — a durable watermark per room with unsent local work.
- `meta` — one row, the workspace this database belongs to.

Derived and rebuildable: `doc_index`, `doc_tags`, `doc_links` and the `docs_fts`
FTS5 table. `clearDerived` plus a re-run of the change handler over every
replica rebuilds all of it from the log-hydrated documents, and that path exists
as the proof the index is derived rather than trusted.

The workspace row is claimed on its own table before the rest of the schema is
created, so a database belonging to another workspace is left byte-identical
and the server refuses to start on it.

## Replica lifecycle

A replica is built by replaying its room's log — snapshot plus tail — never by
asking the hub, and it reads both in one consistent read, because reading them
separately lets a concurrent compaction prune the rows that bridge them.
Replayed updates carry an origin marker the update observer skips, so hydration
cannot double-log.

One update observer per replica appends every update, local and remote origin
alike, before the mutating call returns. An append that is refused is recorded
rather than thrown — throwing inside Yjs transaction cleanup would leave the
document unable to emit later updates — and it immediately quarantines the hub
connection so the change the log refused is never broadcast.

That failure is sticky. Every later call throws, and settling does nothing at
all: no polling, no stub repair, and above all no compaction, because folding
an unlogged change into a snapshot would make it durable. Restart is the only
recovery.

Compaction runs when a room's log passes 500 entries: write
`Y.encodeStateAsUpdate(doc)` and prune the prefix, in one transaction. The
snapshot upsert is monotonic, so a stale compactor is refused rather than
clobbering a newer snapshot.

The pending watermark is written in the same transaction as a local-origin
update, so a kill can never leave a logged local change that nothing remembers
to push. It is released against the minimum of the marker and the replica's own
applied sequence, never the raw marker, because another process may have raised
it in the meantime.

## The hub connection

One websocket for the whole process, with a provider attached per room — a
socket per document would mean a handshake and a backoff per document. A
provider handed a shared socket must be told to attach explicitly or it never
sends its token and silently never syncs. Backoff is capped at two seconds,
deliberately tighter than the library default, so a document created offline is
not stranded.

Tokens are minted locally per connect, carrying the session id, the workspace
uuid and `read-write` scope, and travel in the Hocuspocus auth message rather
than the URL. A rejected token sets a local flag; the hub's own wording is
discarded, because it describes a token we just sent and would otherwise be
echoed back through `sync_status` and the logs.

`HubStatus` is exactly six values: `disabled`, `connecting`, `connected`,
`hub-down`, `auth-failed`, `quarantined`.

## The durability ladder

`applied` — in the update log, on disk, before the tool returned.

`synced` — the hub acknowledged the message. Hub acknowledgement happens on
receipt; the write to the hub's own database is scheduled on a debounce, two
seconds after the last change and ten at the outside. A hub killed inside that
window loses its volatile copy, and recovery is this replica's log re-sending
on reconnect. `synced` is false whenever no provider is attached.

`sync_status` reports both, and its two counts are in different units and are
not expected to agree: `unsyncedChanges` counts rooms, read from the durable
pending set, so it survives a restart; `inFlightUpdates` counts provider sync
messages awaiting acknowledgement on the current connection, which a reconnect
resets to the single handshake message.

## The directory and its stubs

The single stub write site is a repair driven by any observed document update,
local or remote, so "upsert on create or rename" falls out of observation
rather than being remembered at each call site. `meta.title` inside the
document is authoritative; the stub is a cache. A tombstoned stub is skipped,
which is why restoring a document republishes its stub to true up a rename that
landed while it was archived.

Timestamps are epoch milliseconds on the writing replica's clock — sort keys,
not history. `createdAt` is set once and backfilled on repair; `updatedAt` is
stamped immediately when title or tags change and otherwise at most once per
five-minute window, so a burst of content edits costs one directory update.

Index reconciliation is drained after the update is durably logged. A failed
index write is retried once per drain, on a timer, so a locked database cannot
stall a tool call.

## Logging

Stderr only, always, because stdout is the JSON-RPC transport and one stray
write corrupts the session. The one sanctioned stdout writer in the package is
the seed importer, which is a command-line program rather than a transport.

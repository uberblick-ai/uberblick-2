---
uuid: bea0f13c-5ba9-4fb6-af7b-d627b4807786
title: Agents and MCP tools
tags: [feature]
links: [b1d5d904-c8b6-46a1-a4df-22251875bcdb, 2e8de409-df1b-4716-b6a9-71fa2ccd2aca, 8727c914-c462-410a-bff4-0d2975d1dbcc, 06777f59-3159-4511-8236-8fc66d70da27, 8865aba4-fc8b-4050-a8d2-9c851be0bed3]
---

An agent talks to uberblick over a stdio MCP server that owns a local replica
of the workspace. It starts and serves every tool with no hub reachable, and
every write is block-scoped.

## The nineteen tools

Reading:

- `get_doc` — metadata, blocks and annotation threads. Every block carries its `rev`.
- `list_docs` — every document, read from the synced directory document, never from locally observed creations. Filters by `tag`, optionally includes archived ones.
- `search` — full-text over titles and block text from the local FTS5 index. A trailing `*` is a prefix match; FTS5 operators in a query are searched for rather than executed.
- `backlinks` — documents whose `links` name this one.
- `export_markdown` — the document as markdown, fenced code and mermaid included, with optional frontmatter and optional annotation comments.
- `sync_status` — what this replica holds and what the hub has acknowledged.
- `get_sidebar` — the workspace's curated navigation.

Writing:

- `create_doc` — creates a document and publishes its directory stub. Blocks are optional.
- `insert_block`, `edit_block`, `delete_block` — one block at a time.
- `set_tags`, `set_links` — replace the whole set. Links are uuids.
- `archive_doc`, `restore_doc` — tombstone and lift a directory stub.
- `annotate` — open a thread over a range, or add a comment to one.
- `pin_doc`, `unpin_doc`, `sidebar_group` — curate the sidebar.

There is no whole-document write, no hard delete, and no markdown import. The
tool list is pinned by a test that asserts equality rather than a superset: an
extra tool is a contract change.

## Durability, reported honestly

Every mutating tool returns `applied` and `synced`, plus the hub's current
state. `applied` means the update is in this replica's append-only log, on
disk, before the call returned. `synced` means the hub acknowledged receipt —
not that the hub has written it to its own disk: the hub acks on receipt and
schedules its write on a debounce, so a hub killed inside that window loses its
volatile copy and recovers it from this replica's log on reconnect.

`synced` is false whenever no hub connection is attached at all, which is the
normal state of a local-only machine.

## Failing safely

`edit_block` asserts the text you read and, if you pass it, the block's `rev`.
A stale call returns `stale_block` with the current text and the current rev,
and the instruction to re-diff and call again — no second round trip needed.
Other named failures are `block_not_found`, `doc_not_found`, `doc_archived`,
`annotation_range`, `thread_not_found`, `invalid_arguments` and
`persistence_failed`.

A refused write to the update log is fatal on purpose. The replica records the
failure, quarantines the hub connection so the unlogged change is not
broadcast, and refuses every later call until the process restarts. A change
that is not in the log is not allowed to become durable anywhere else.

## Visibility

Every agent session publishes awareness, so it appears in the web editor with a
name, a colour and a cursor. `edit_block` parks a cursor at the end of the text
it just wrote.

## Registering the server

`ub mcp install [claude|codex|cursor]` writes the client's config; the
registered command is always `ub mcp serve`, which resolves the workspace, hub
endpoint and signing secret itself and spawns the server with them.

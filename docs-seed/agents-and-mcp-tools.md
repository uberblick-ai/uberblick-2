---
uuid: bea0f13c-5ba9-4fb6-af7b-d627b4807786
title: Agents and MCP tools
tags:
  - feature
links:
  - 8865aba4-fc8b-4050-a8d2-9c851be0bed3
  - b1d5d904-c8b6-46a1-a4df-22251875bcdb
  - 2e8de409-df1b-4716-b6a9-71fa2ccd2aca
  - f1f403e6-fb4b-4e95-b12f-4fc0df8f4957
  - 9b4ea859-8304-4e11-9cc8-76232c16a4e5
---

This doc runs ahead of the code: the MCP server is issue #3, in progress. The
package is a scaffold today and registers no tools.

Agents reach uberblick through an MCP stdio server that holds a Y.Doc replica per
document and mirrors it into a local SQLite index. Every write is scoped to one
block and is checked against what the caller read, so a concurrent human edit is
never clobbered. The server answers with the hub unreachable, and says so rather
than pretending a local write is synced.

## The v0 tool set

- `create_doc` — create a document, seed `meta`, upsert its directory stub.
- `get_doc` — read metadata and every block, each with its `rev`.
- `list_docs` — list the directory document's stubs, tombstones excluded.
- `search` — full-text query over the local index, by text and tag.
- `backlinks` — documents whose `meta.links` name a given UUID.
- `edit_block` — replace one block's text, guarded by `old_text` and `rev`.
- `insert_block` — insert a block after a given block, or at the start.
- `delete_block` — delete one block by id.
- `set_tags` — replace a document's tag set.
- `set_links` — replace a document's outbound link set, by UUID.
- `annotate` — open a comment thread over a range of one block.
- `export_markdown` — render a document as markdown, one way.
- `sync_status` — report connection state and unsynced update counts.

## Contracts

Block-scoped writes only. There is no whole-document replace tool, and there
will not be one: a document-scoped write would clobber concurrent human edits,
which is the failure mode the model exists to prevent.

Staleness discipline. Every read returns a per-block `rev`, a content hash of the
block's type, text and attributes. `edit_block` refuses when `old_text` or the
asserted `rev` no longer matches, and the error carries the current text and rev
so the caller re-reads and retries. The check is local-replica-only: there is no
cross-replica compare-and-set, and the guarantee weakens while offline.

Durability honesty. Mutating tools return `{applied, synced}`. Applied locally is
not synced to the hub, and the call returns before the hub acknowledges.

Offline-first by construction. The append-only update log is the authoritative
local replica: replicas hydrate from it on boot, never from the hub, and every
tool works with the hub down.

---
uuid: 9b4ea859-8304-4e11-9cc8-76232c16a4e5
title: Architecture
tags:
  - reference
links:
  - 8865aba4-fc8b-4050-a8d2-9c851be0bed3
  - b1d5d904-c8b6-46a1-a4df-22251875bcdb
  - 2e8de409-df1b-4716-b6a9-71fa2ccd2aca
  - bea0f13c-5ba9-4fb6-af7b-d627b4807786
  - 8727c914-c462-410a-bff4-0d2975d1dbcc
---

One Y.Doc per document, one room per Y.Doc, one SQLite row per room, and every
index derived from that state rather than trusted as it.

## Document model

- `meta` — a Y.Map holding `uuid`, `title`, `tags` and `links`, all by UUID.
- `blocks` — a Y.XmlFragment, one element per block, each holding a single
  Y.XmlText of source. This fragment is what the web editor binds to.
- `annotations` — a Y.Map of thread id to thread JSON.
- `packages/schema` owns this layout and is imported by everything else. Its
  only runtime dependencies are `yjs` and a diff library.

## Rooms

- A room is `<workspaceId>/<docUuid>`; a workspace's directory document is at
  `<workspaceId>/_directory`.
- Tenancy is in the room key from day one, so a hosted hub never needs a room
  migration.
- The hub reads the room name strictly — exactly two non-empty segments — and
  refuses any room outside the workspace the token claims.

## Hub persistence

- The hub is a Hocuspocus server with the SQLite extension: one row per
  document, holding `Y.encodeStateAsUpdate(doc)`, hydrated with `Y.applyUpdate`.
- It is a full state snapshot per document, not an appended update stream, so
  there is nothing to prune.
- Tokens are claims-shaped, `{sub, workspace, scope}`, HMAC-signed and delivered
  in the Hocuspocus auth message. A token in the URL query string is rejected.

## MCP local state

- Planned: an append-only update log is the authoritative local replica.
  Replicas hydrate from it on boot, never from the hub, and it records every
  update — local and remote origin alike — synchronously before a mutating call
  returns.
- The SQLite mirror over it (FTS5, tags, backlinks) is derived and rebuildable,
  never authoritative. The same holds for the directory document's stubs, which
  are a cache repaired on write and connect.

## Invariants worth restating

- One update encoding everywhere: Yjs v1. Never mix v1 and v2.
- Exactly one `yjs` module instance per process, pinned by catalog and
  overrides, with `yjs` a peer dependency of the schema package.
- Identity is UUIDs; titles and paths are display data.
- The MCP server writes nothing to stdout but JSON-RPC; logs go to stderr.

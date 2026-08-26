---
uuid: 8865aba4-fc8b-4050-a8d2-9c851be0bed3
title: Concepts
tags:
  - start-here
links:
  - 3231bff4-fb3c-4195-a83a-98031551ca68
  - b1d5d904-c8b6-46a1-a4df-22251875bcdb
  - 2e8de409-df1b-4716-b6a9-71fa2ccd2aca
  - bea0f13c-5ba9-4fb6-af7b-d627b4807786
  - 9b4ea859-8304-4e11-9cc8-76232c16a4e5
---

Eight terms, used with these exact meanings by every other document.

## Document

One Y.Doc, identified by a UUID, with three top-level shared types: `meta`,
`blocks` and `annotations`. All document state lives in the Y.Doc, never in
server-side tables.

## Block

One Y.XmlElement in the `blocks` fragment, carrying a stable `id` attribute and
a single Y.XmlText of plain-text source. The four types are paragraph, heading,
code and mermaid.

## Annotation

A comment thread stored as JSON in the `annotations` map and anchored by a
`comment` formatting mark on a block's Y.XmlText. The mark carries the thread
id; the JSON carries no positions.

## Tag

A string in `meta.tags`. Tags are a plain array replaced wholesale on write, and
they are mirrored into the directory document's stub for the document.

## Link

A target document UUID in `meta.links`. Links reference UUIDs, never paths or
titles, so renaming a document breaks nothing.

## Workspace

The tenancy segment of a room name, and a uuid — optionally decorated for display
as `<slug>-<uuid>`, with the slug parsed off before the id reaches a room, a
token claim or the SQLite filename. There is no default workspace and nothing to
create: several coexist on one hub with separate corpora, and a workspace's rooms
exist the moment something opens one.

Separation is namespacing for one trusted user, not a security boundary — one
signing secret still mints a token for any workspace, so it separates corpora,
not people; real isolation waits on per-workspace auth (issue #84).

A machine gets a workspace one of two ways: `ub init` generates a new one (and
seeds it), or `ub remote join <endpoint>/<workspace-id>` binds it to one that
already exists on a hub. Several can sit side by side on one machine — each with
its own replica file — listed by `ub workspace list`; the one in force is chosen
by `ub workspace use`.

## Room

A sync channel name, `<workspaceId>/<docUuid>`: one Y.Doc, one Hocuspocus room,
one SQLite row in the hub. Both segments must be non-empty and contain no
slash.

## Directory document

The document at `<workspaceId>/_directory`, holding a Y.Map of uuid →
{title, tags, deleted?} stubs. Discovery is itself a synced doc; stubs are a
cache, and `meta.title` in the document wins.

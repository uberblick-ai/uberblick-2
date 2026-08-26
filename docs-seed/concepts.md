---
uuid: 8865aba4-fc8b-4050-a8d2-9c851be0bed3
title: Concepts
tags: [reference]
links: [3231bff4-fb3c-4195-a83a-98031551ca68, 9b4ea859-8304-4e11-9cc8-76232c16a4e5, b1d5d904-c8b6-46a1-a4df-22251875bcdb, bea0f13c-5ba9-4fb6-af7b-d627b4807786, 6ea21fbd-aef9-4e69-873e-6c2a182e8894]
---

The vocabulary every other document uses with these exact meanings. When two
documents disagree about a word, this one is what they meant.

## Identity and place

- **Workspace** — a uuid, assigned by `ub init`, never guessable, with no default. For display it may be decorated as `<slug>-<uuid>`; the slug is cosmetic and is parsed off before the id reaches a room, a token claim or a database filename.
- **Room** — the sync key, `<workspaceUuid>/<docUuid>`: exactly two non-empty segments. Two reserved document slots exist, `_directory` and `_sidebar`.
- **Document** — one Y.Doc, identified by its uuid. Its title is display data; on conflict `meta.title` inside the document wins over the directory stub.
- **Directory** — the synced document at `<workspaceUuid>/_directory` holding a stub per document: title, tags, `deleted`, `createdAt`, `updatedAt`. It is a cache, repaired on write and on connect, and it is what `list_docs` reads.
- **Sidebar** — the synced document at `<workspaceUuid>/_sidebar`, holding named groups of pinned document uuids. It stores uuids and nothing else.

## Inside a document

- **Block** — one element of the `blocks` fragment, carrying a stable `id` and exactly one text child. The seven types are `paragraph`, `heading`, `code`, `mermaid`, `list-item`, `quote` and `table`.
- **Prose block** — `paragraph`, `heading`, `list-item`, `quote`: the blocks that may carry inline marks. The others hold source text.
- **Mark** — a Yjs text-formatting key on a block's text. The closed set is `bold`, `italic`, `strike`, `inlineCode` and `link`, plus `comment`.
- **Annotation** — a comment thread in the `annotations` map, anchored by a `comment` mark on the text rather than by a position.
- **rev** — a per-block content hash returned by every read and asserted by `edit_block`. Marks are deliberately excluded from it.

## Durability words

- **applied** — the update is in this replica's append-only log, on disk, before the tool returned.
- **synced** — the hub acknowledged receipt. It does not mean the hub has written it to its own disk.
- **archived** — the directory stub is tombstoned. Nothing is erased: every block, mark and thread stays where it was, and there is no tool that erases content.

## Tags

A document carries exactly one of five tags, and the web client groups the corpus by them: start-here, feature, verify, reference and implementation-reference.

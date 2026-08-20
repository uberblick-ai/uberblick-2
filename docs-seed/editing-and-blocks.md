---
uuid: b1d5d904-c8b6-46a1-a4df-22251875bcdb
title: Editing and blocks
tags:
  - feature
links:
  - 8865aba4-fc8b-4050-a8d2-9c851be0bed3
  - 2e8de409-df1b-4716-b6a9-71fa2ccd2aca
  - bea0f13c-5ba9-4fb6-af7b-d627b4807786
  - f1f403e6-fb4b-4e95-b12f-4fc0df8f4957
  - 9b4ea859-8304-4e11-9cc8-76232c16a4e5
---

A document is a flat list of blocks; every write touches one block, and a block
keeps its id for life.

## The four block types

- `paragraph` — plain text, no inline formatting stored.
- `heading` — plus a `level` attribute, stored as a string, clamped to 1–6 at
  render time only.
- `code` — plus a `language` attribute, exported as a tagged fence.
- `mermaid` — a text block by storage, exported as a fence tagged `mermaid`.

The editor palette offers exactly these: ¶, H1, H2, H3, code, mermaid.

## Stable ids

- Each block element carries a UUID `id` attribute assigned on insert.
- Annotation threads, agent edits and inbound references all key on that id.
- The editor's node specs declare `id`, so binding never strips it.

## Re-typing a block

- `setBlockType` is the only sanctioned re-type. It inserts a replacement
  element with the same id at the same position, replays the old text's delta
  into it — marks included — and deletes the old element, all in one
  transaction.
- Delete-and-reinsert is an invariant violation: it churns the id and orphans
  every annotation anchored in the block.
- Two replicas re-typing one block concurrently therefore converge on two
  elements sharing its id. Reads shadow the later one in document order — every
  read returns exactly one block per id, and every replica picks the same winner
  — and the MCP server deletes the shadowed element as soon as it observes the
  duplicate, keeping the winner. `deleteBlock` removes every copy, so a repaired
  block cannot come back.

## Unknown content degrades loudly

- The palette is scanned against the fragment before an editor is bound, and
  recursively: unknown node name, nested element, undeclared mark, or a non-string
  delta insert all count as foreign.
- On any hit the app refuses to bind ProseMirror and renders a read-only banner,
  "Unsupported content — editor disabled." Nothing is deleted from the document.
- The refusal exists because y-prosemirror's error path deletes the offending Y
  type, and that deletion would replicate.

## Known limits

- A duplicate id left by concurrent re-types is invisible to reads immediately,
  but it is removed from the document only when an MCP server observes it: the
  web client does not repair, so a document only browsers have seen keeps the
  extra element until an agent session touches it.
- A text edit made concurrently with a re-type loses its characters with the
  replaced element — including edits written into the losing copy of a
  duplicated block, which the repair deletes. `rev` and `old_text` protect a
  caller who checks. Divergent duplicate texts are never merged.
- There is no move operation. Blocks are inserted, appended and deleted;
  reordering means delete and reinsert, which changes the id.

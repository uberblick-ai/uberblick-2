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

## Unknown content degrades loudly

- The palette is scanned against the fragment before an editor is bound, and
  recursively: unknown node name, nested element, undeclared mark, or a non-string
  delta insert all count as foreign.
- On any hit the app refuses to bind ProseMirror and renders a read-only banner,
  "Unsupported content — editor disabled." Nothing is deleted from the document.
- The refusal exists because y-prosemirror's error path deletes the offending Y
  type, and that deletion would replicate.

## Known limits

- Two replicas re-typing the same block while unsynced converge on two elements
  sharing one id. The fix is decided (dedupe-on-read plus repair-on-observe) and
  not implemented — issue #11.
- A text edit made concurrently with a re-type loses its characters with the
  replaced element. `rev` and `old_text` protect a caller who checks.
- There is no move operation. Blocks are inserted, appended and deleted;
  reordering means delete and reinsert, which changes the id.

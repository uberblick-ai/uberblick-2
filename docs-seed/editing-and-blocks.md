---
uuid: b1d5d904-c8b6-46a1-a4df-22251875bcdb
title: Editing and blocks
tags: [feature]
links: [8865aba4-fc8b-4050-a8d2-9c851be0bed3, bea0f13c-5ba9-4fb6-af7b-d627b4807786, 2e8de409-df1b-4716-b6a9-71fa2ccd2aca, 8a070124-2dc6-442a-8ea9-6db5b63ca950, 5238bd29-f9d5-43e8-ad40-2f039c705521]
---

A document is a flat list of blocks. Every block has a stable id, one text
child, and a type from a closed set. Every write — from an agent or from the
editor — touches one block.

## The seven block types

- `paragraph` — plain prose.
- `heading` — carries `level`, 1 to 6, clamped rather than rejected.
- `list-item` — carries `list` (`bullet` or `ordered`) and `indent`, 0 to 3. A list is a run of adjacent list-item blocks; nothing nests, and ordered numbering is computed at render time rather than stored.
- `quote` — prose; a multi-line quote is one block.
- `code` — source text, carrying an optional `language`.
- `mermaid` — source text rendered as a diagram.
- `table` — the block's text is GFM table source; there is no cell tree, so a bold marker inside a cell is literal text.

## Inline formatting

Prose blocks — paragraph, heading, list-item and quote — may carry five inline
marks: `bold`, `italic`, `strike`, `inlineCode` and `link`. Source blocks —
code, mermaid and table — carry only the `comment` mark that anchors an
annotation. The mark is named `inlineCode` rather than `code` because
ProseMirror forbids one name being both a node and a mark, and a mark's name is
its Yjs key.

A link mark's target must be an `http` or `https` URL. A reference to another
document is never a link mark: it is a uuid in the document's `links`.

## Editing one block

Reads return a `rev` per block — a content hash over the block's type, its
attributes and its text. Marks are deliberately excluded, so annotating or
bolding a range never invalidates an edit somebody has already prepared.

`edit_block` takes the text you read and, optionally, that `rev`, asserts both,
and then applies the change as a diff-and-splice: only the characters that
actually differ are touched. A concurrent edit elsewhere in the same block
survives, and every mark over untouched text stays anchored. Text spliced in
inherits the formatting of the character to its left.

The stale check is against this replica at the moment of the call. There is no
cross-replica compare-and-swap, and the window widens the longer a replica
stays offline. It guarantees that an edit never silently overwrites a change
this replica has already seen — not more than that.

## Changing a block's type

`setBlockType` is the only sanctioned re-type. It keeps the block id, replays
the whole text delta including every mark, and keeps the block's position.
Delete-and-reinsert is forbidden: it churns the id, breaking every inbound
reference, and drops the marks, orphaning every annotation anchored in the
block.

Turning a prose block into a source block is refused while its text still
carries inline formatting, and refused before anything is mutated, because a
Yjs transaction does not roll back.

## Concurrency you can rely on

Two replicas that re-type the same block converge on two elements sharing one
id; the earlier in document order wins identically everywhere and the later is
shadowed by every read, then swept. The losing copy's text is discarded rather
than merged — divergent duplicate texts are never combined.

## Limits worth knowing

- There is no whole-document write, from any client, by design.
- Nothing erases content: `archive_doc` tombstones a directory stub and leaves every block, mark and thread where it was.
- Neither `insert_block` nor `edit_block` can write an inline mark today; the mark-aware reader is the seed importer, and exposing it as a tool is open work.

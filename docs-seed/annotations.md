---
uuid: 2e8de409-df1b-4716-b6a9-71fa2ccd2aca
title: Annotations
tags:
  - feature
links:
  - 8865aba4-fc8b-4050-a8d2-9c851be0bed3
  - b1d5d904-c8b6-46a1-a4df-22251875bcdb
  - 9b4ea859-8304-4e11-9cc8-76232c16a4e5
---

An annotation thread is JSON with no positions; its range lives in the text as a
formatting mark.

## Anchoring

- The block's Y.XmlText carries a `comment` mark valued `{ threadId }` over
  exactly the annotated characters.
- The thread JSON in the `annotations` map holds `id`, `blockId`, `comments` and
  an optional `resolved`.
- The mark is part of the text's own CRDT state, so it survives concurrent
  edits, a block split and a `setBlockType` re-type.
- y-prosemirror delivers it to Tiptap as a `comment` mark with a `threadId`
  attribute.

## Ranges

- Overlap is rejected, not nested: marking characters that already carry another
  thread's mark fails, and an empty range fails too.
- Indices are clamped to the text length and swapped if reversed.
- Text typed inside a span, or at its end boundary, joins the span; text typed at
  its start boundary stays outside. Deleting part of a span shrinks it.

## When the range is gone

- Deleting every annotated character removes the mark, and the thread's range
  then resolves to null.
- The thread JSON is never cascade-deleted: the conversation outlives its anchor,
  and its block's deletion.
- Resolving a thread leaves the mark in place, so it is still shown in position.

## Writes

- Thread bodies are replaced wholesale, last-write-wins per thread.
- Deleting a thread clears its mark run by run, leaving interleaved foreign marks
  untouched.
- Markdown export drops threads unless HTML comments are requested, and omits
  unanchored ones.

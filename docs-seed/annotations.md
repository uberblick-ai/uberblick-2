---
uuid: 2e8de409-df1b-4716-b6a9-71fa2ccd2aca
title: Annotations
tags: [feature]
links: [b1d5d904-c8b6-46a1-a4df-22251875bcdb, bea0f13c-5ba9-4fb6-af7b-d627b4807786, 8a070124-2dc6-442a-8ea9-6db5b63ca950, 5238bd29-f9d5-43e8-ad40-2f039c705521]
---

A comment thread is anchored by a formatting mark on the text itself, not by a
position. That is why a thread survives edits, splits and block re-types made
by somebody who never saw it.

## What is stored

The `annotations` map holds one thread per id:

```jsonc
{ "id": "<uuid>", "blockId": "<block id>",
  "comments": [ { "author": "…", "text": "…", "createdAt": "<ISO-8601>" } ],
  "resolved": true }
```

The thread carries no positions at all. The range lives on the block's text as
a `comment` mark whose value is the thread id, applied over exactly the
annotated characters. The value is ProseMirror-shaped on purpose, so the web
editor surfaces it as a mark with a `threadId` attribute and no translation
layer sits in between.

## How a range behaves

- Text typed strictly inside the span joins it. Text typed at the span's end boundary also joins it, because a Yjs insert inherits the formatting of the character to its left. Text at the start boundary stays outside.
- Deleting part of the span shrinks it. Deleting all of it removes the mark; the thread is not cascade-deleted, and the range then resolves to nothing.
- A re-type replays the delta, so the mark comes across with the text.

## Overlaps are refused, not nested

A second thread over characters another thread already holds is rejected with a
range error naming the thread it clashes with. A Yjs formatting key holds one
value per character and a ProseMirror mark type has the same rule, so a nested
thread would steal characters rather than layer over them.

An empty range is refused too. Indices are clamped to the text length and
swapped if they arrive reversed.

## Reading threads

`get_doc` returns each thread with its resolved range. A range that no longer
exists comes back as null, and the thread stays listed — an orphaned thread is
visible, never silently dropped. Ranges are read in one pass over the text's
delta, adjacent runs of the same thread merged, including runs whose thread
JSON has gone.

Resolving a thread leaves its mark in place: a resolved thread is still
anchored. Deleting a thread clears its mark run by run rather than as one span,
so a foreign writer's interleaved mark inside the range is left untouched.

## In the editor and in export

The web client renders a commented range as a focusable span and lists threads
in a rail beside the document. `export_markdown` drops threads by default; with
`annotations: "html-comments"` it emits one HTML comment per thread after its
block, carrying the range, the author and the text, indented to stay inside a
list item. Threads whose anchor no longer resolves are omitted from the export.

## Limits

- One thread per character. No nesting, no overlapping.
- Thread bodies are replaced wholesale, so two replicas commenting on the same thread concurrently resolve last-write-wins per thread.
- Authorship is whatever the caller passed; there is no identity behind it.

---
uuid: 8a070124-2dc6-442a-8ea9-6db5b63ca950
title: Schema API reference
tags: [implementation-reference]
links: [9b4ea859-8304-4e11-9cc8-76232c16a4e5, b1d5d904-c8b6-46a1-a4df-22251875bcdb, 2e8de409-df1b-4716-b6a9-71fa2ccd2aca, 06777f59-3159-4511-8236-8fc66d70da27, 5238bd29-f9d5-43e8-ad40-2f039c705521]
---

`@uberblick/schema` owns the document shape and every operation on it. Every
other package imports it and none of them reimplement it. Source lives in
`packages/schema/src`; go there for the reasoning, here for the surface.

## Dependencies

One runtime dependency, `fast-diff`, used only by `editBlock`. `yjs` is a peer
dependency pinned through the pnpm catalog, so exactly one Yjs module instance
exists per process. Everything else — the markdown reader and writer, the GFM
table parser, the rev hash, the workspace-id parse — is dependency-free.

## Document roots — `doc.ts`

`getMetaMap`, `getBlocksFragment` and `getAnnotationsMap` take a `Y.Doc` and
return the three roots. `initDoc(ydoc, {uuid, title, tags})` touches all three
so they appear in the update stream from the start. `getMeta` reads back
`{uuid, title, tags, links}`, defaulting missing values and filtering
non-strings rather than throwing. `setTitle`, `setTags` and `setLinks` replace
whole values.

## Blocks — `blocks.ts`

```ts
getBlocks(ydoc): Block[]
getBlock(ydoc, blockId): Block | null
getBlockText(ydoc, blockId): string
getBlockRev(ydoc, blockId): string
getBlockInline(ydoc, blockId): InlineRun[]
insertBlock(ydoc, afterBlockId, input): string
appendBlock(ydoc, input): string
deleteBlock(ydoc, blockId): void
setBlockLevel(ydoc, blockId, level): void
setBlockLanguage(ydoc, blockId, language): void
setBlockType(ydoc, blockId, newType, attrs?): void
editBlock(ydoc, blockId, oldText, newText, { rev? }): void
repairDuplicateBlocks(ydoc): number
```

A block is a `Y.XmlElement` whose node name is the block type, carrying an `id`
attribute and exactly one `Y.XmlText` child. Attribute values are strings.
`heading` carries `level`, `code` carries `language`, `list-item` carries
`list` and `indent` — the last two always written, so no reader default is
involved.

Duplicate ids are a merge outcome, not an error: the first element in document
order to claim an id is visible and every later one is shadowed by every read.
`repairDuplicateBlocks` deletes the shadowed ones. An unknown node name reads
as a paragraph rather than throwing.

`editBlock` asserts `oldText`, and `rev` when given, then applies
`fastDiff(oldText, newText)` as minimal deletes and inserts inside one
transaction. Identical text is a no-op. A block detached during the transaction
raises `BlockNotFoundError` rather than reporting success.

`setBlockType` inserts a new element of the target type carrying the same id at
the next index, replays the old text's whole delta into it, and deletes the
old. Attributes carry over from the old type unless `attrs` overrides them.
Prose-to-source is refused before anything is mutated when the text carries any
formatting key other than a readable `comment`.

## Marks — `marks.ts`, `types.ts`

`INLINE_MARKS` is `bold`, `italic`, `strike`, `inlineCode`, `link`;
`COMMENT_MARK` is `comment` and is deliberately not one of them.
`PROSE_BLOCK_TYPES` is `paragraph`, `heading`, `list-item`, `quote`. The Yjs
formatting key is the bare mark name and the value is a ProseMirror-shaped
attribute object. `isExternalHref` is the single definition of a writable link
target, `http` or `https` only; writing anything else throws
`InvalidLinkHrefError`, while reading a bad one degrades to unmarked.

## Rev — `rev.ts`

`blockRev({type, level, language, list, indent, text})` JSON-encodes those
fields in that order and returns sixteen lowercase hex characters: FNV-1a 32
and djb2 concatenated. It reads UTF-16 code units, exactly what Yjs indexes.
Marks are excluded on purpose. It is a change detector, not a version counter,
and not cryptographic.

## Rooms and workspaces — `rooms.ts`, `workspace.ts`

`roomForDoc`, `directoryRoom` and `sidebarRoom` build names; `parseRoom` reads
them strictly and rejects a workspace segment carrying a display slug.
`parseWorkspaceId(value, label?)` returns `{uuid, slug}` and throws
`InvalidWorkspaceIdError` naming only the label — never the rejected value,
because a secret mis-exported as `WORKSPACE_ID` must not be echoed.

## Directory and sidebar — `directory.ts`, `sidebar.ts`

`upsertDirectoryEntry`, `tombstoneDirectoryEntry`, `restoreDirectoryEntry`,
`getDirectoryEntry` and `listDirectory` operate on the `docs` map of the
directory document. `createdAt` is set once; a tombstone is sticky; listing
sorts by title then uuid so every replica agrees.

`sidebar.ts` holds `groups`, `order`, `unpinned` and `flags`, with
`createGroup`, `renameGroup`, `deleteGroup`, `moveGroup`, `pinDoc`, `unpinDoc`,
`moveDoc` and `readSidebar`. It stores uuids and nothing else. One pin per
document is a read rule, not a write rule, and unpinning writes a counter under
this client's own key so concurrent unpins never fight.

## Annotations — `annotations.ts`

`createAnnotation`, `getAnnotation`, `listAnnotations`,
`listAnnotationsForBlock`, `listAnnotationRanges`, `resolveAnnotationRange`,
`addComment`, `setAnnotationResolved`, `deleteAnnotation`.

## Markdown — `markdown.ts`

`exportMarkdown(ydoc, {frontmatter?, annotations?})` writes frontmatter by
default, carrying `uuid`, `title` and `tags` — but never `links`, which the
reader does understand. `importMarkdown(markdown)` returns
`{title, tags, uuid?, links?, blocks}`; a leading level-1 heading becomes the
title only when frontmatter carries none, and is then consumed.

The round-trip guarantee: text never changes, per-character mark sets are
stable from the first export's re-read onward, and exporting a re-import is
byte-identical to its source. The two named exceptions are marks over
whitespace-only runs and two code spans that would meet with nothing writable
between them.

## Errors — `errors.ts`

`BlockNotFoundError`, `StaleBlockError`, `AnnotationRangeError`,
`MarksNotAllowedError`, `InvalidLinkHrefError`, `InvalidRoomError`,
`InvalidWorkspaceIdError`. `StaleBlockError` carries `expectedText`,
`expectedRev`, `currentText` and `currentRev` so a caller can re-diff without
another read.

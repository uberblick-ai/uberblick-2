---
uuid: 026e1af0-3dca-4c55-9c8b-eead5818fc89
title: Awareness and cursor wire formats
tags: [implementation-reference]
links: [8727c914-c462-410a-bff4-0d2975d1dbcc, 5238bd29-f9d5-43e8-ad40-2f039c705521, bea0f13c-5ba9-4fb6-af7b-d627b4807786]
---

The exact awareness payload a client must publish to appear, and be attributed,
in the editor. Get a field wrong and the client is invisible rather than
broken, so this is pinned by tests on both sides.

## The three fields

```jsonc
{
  "user":   { "name": "Claude · demo agent", "color": "#7b5ec7" },
  "cursor": { "anchor": <relative position JSON>, "head": <same> },
  "client": "web"
}
```

- `user` is required for a session to be seen at all. `name` is any non-empty string; `color` must match `#rrggbb` exactly, because y-prosemirror validates it against that pattern and drops anything else. A peer publishing no colour is drawn in a neutral grey.
- `cursor` is what draws a caret. Omitting it, or setting it to null, removes the caret while leaving the session present.
- `client` is the only discriminator between a browser and everything else. The web client publishes the literal `"web"` once per room; nothing else publishes it. There is no positive agent marker, so "is an agent" is an absence test, and a browser tab that has not reloaded since the field shipped counts as an agent until it does.

There is no `lastAction` field. It is planned and referenced as absent in three
places in the code.

## Encoding a cursor

Both `anchor` and `head` are the JSON form of a Yjs relative position, produced
by creating a relative position from a type and an index and serialising it —
not by converting an absolute ProseMirror position. The type they are anchored
in is the **block's** `Y.XmlText`, never the `blocks` fragment. A caret is
`anchor` equal to `head`; a selection is not.

The JSON carries `type`, `item` and `assoc` keys and is transported by the
awareness protocol's plain JSON serialisation, so nothing further is needed to
put it on the wire.

A state that does not decode — a stale relative position, a document the reader
has not caught up with — is skipped silently rather than breaking the render.

## Where each side lives

The web client publishes `user` and `client` when it opens a room and
republishes `user` whenever the reader changes the presence colour, comparing
against what it last published so an unrelated settings write puts nothing on
the wire. The cursor field is written by y-prosemirror's cursor plugin rather
than by application code. The MCP server publishes the same shape for its
session, and parks a cursor at the end of the text after an `edit_block`.

A worked reference publisher, with the format documented in prose beside it,
runs as `mise run agent-cursor`.

## How readers use it

- The caret and its label are y-prosemirror's own decorations, styled by the application.
- The peer chips and the presence list read `user` alone.
- The activity pill decodes `cursor.anchor`, takes the containing block, and maps it to a one-based block number, so it can say which block a session is in.
- The agent count is asked of the workspace's directory room, because every session joins it, and counts remote states that carry a `user` and do not carry `client: "web"`. A state with no `user` at all — the connectivity probe the CLI's remote commands open — is nobody.

## What pins the format

A unit test builds the payload and feeds it to y-prosemirror's own decoration
builder, asserting the rendered caret and label; a second asserts the key set
of the relative-position JSON and its round trip back to an index. A third
pins the presence colour end to end over a real awareness instance. Two
browser-level proof points cover the rest: a peer's cursor rendering with its
name and colour, and a connected non-browser client being counted as one agent
session.

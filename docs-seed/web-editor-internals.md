---
uuid: 5238bd29-f9d5-43e8-ad40-2f039c705521
title: Web editor internals
tags: [implementation-reference]
links: [b1d5d904-c8b6-46a1-a4df-22251875bcdb, 8a070124-2dc6-442a-8ea9-6db5b63ca950, 026e1af0-3dca-4c55-9c8b-eead5818fc89, 8727c914-c462-410a-bff4-0d2975d1dbcc]
---

What a web-editor change must never do, and where the machinery lives. Source
is `packages/web/src`.

## Three rules the node definitions exist to satisfy

- Every node declares an `id` attribute, because y-prosemirror strips any attribute the schema does not declare.
- Attribute values stay strings, verbatim. `level`, `indent` and `list` are compared with strict inequality when the fragment is diffed, so normalising them in the schema would rewrite the document on load. Clamping happens at render time only.
- Every node allows the `comment` mark, source blocks included, because a text node that refuses a mark makes y-prosemirror delete the Y.XmlText rather than drop the mark.

There is no StarterKit. The ProseMirror schema is built from exactly the seven
block nodes, the five inline marks and the comment mark, so nothing the schema
does not own can enter through an extension's defaults.

## The guarded binding

Unknown content must never reach y-prosemirror, because its fragment
reconciliation deletes what it cannot represent — silently, in the CRDT, for
everyone.

Two gates. At load, the editor is not created at all when the fragment already
holds foreign blocks. At run time, a guard registered on the document's
`beforeObserverCalls` event destroys the editor synchronously the moment
foreign content arrives — Yjs emits that before any deep observer, so the
binding never gets a chance to react. A shallow fragment observer was the old
bug: it fired too late.

Foreign means a top-level child that is not an element, an element whose name
is not a block type, a nested element or non-text child inside a known block, a
non-string insert, a mark the block does not allow, or a mark whose value does
not read as a mark. The fragment is left untouched; the pane renders a banner
and a read-only listing of the raw blocks instead.

## Block ids

An append-transaction plugin walks the top-level blocks and assigns a fresh
uuid to any block whose id is missing or already claimed by an earlier block.
It deliberately does not mark itself as outside history: doing so made the
whole enclosing Yjs transaction uncaptured.

## Collaboration wiring

The sync plugin, then the cursor plugin, then the undo plugin, in that order,
bound to the schema-owned `blocks` fragment — never to y-prosemirror's default
fragment. The cursor plugin is skipped when there is no awareness. Undo and
redo are bound to the Yjs history, not ProseMirror's.

## The palette

Ten entries in one array drive all three ways of creating a block: typing `/`
in an empty paragraph, the gutter `+`, and markdown input rules. The entries
are paragraph, headings one to three, quote, bullet and numbered list, code,
table and mermaid.

Both operations name the block by id and re-resolve it before acting, so a
block that moved or vanished is a refusal rather than a wrong edit. Conversion
goes through the sanctioned re-type, keeping the id; insertion creates a block
with no id and lets the id plugin assign one.

## Chrome versus content

ProseMirror owns every child of the editor element. Anything positioned against
the prose — the block menu, the comment composer — lives on a sibling frame
element. Per-block chrome is a node view: a copy button on source blocks, and a
table view that renders GFM source as a table and swaps back to the source when
the caret enters it.

Document chrome is the breadcrumb, tag chips, pin toggle and sync pill;
application chrome is the header, the sidebar and the rails.

## Styling

Hand-written CSS classes prefixed `ub-` are the house style. Tailwind v4 is
present but confined: preflight is off, everything it emits is layered so the
plain classes always win, its theme tokens are mapped onto the custom
properties the stylesheet already defines, and its source scanning is pointed
at the vendored component directory only so it stops mining class names out of
prose.

Exactly three vendored shadcn files exist: a local class-joining helper, a
dropdown menu and a popover. Everything else is hand-written.

## Sidebar, workspaces and the all-docs view

The sidebar is a rendering of the `_sidebar` document, read through the schema
and written through the same schema operations an agent's `pin_doc` uses.
Nothing derives groups from tags. Drag and drop is native, and the landing
index compensates for Yjs having no move operation. Group collapse and sidebar
collapse are per-browser, in local storage.

The workspace switcher is a menu over the configured workspaces; switching is a
navigation, and nothing carries across. The all-docs view is fed by directory
stubs alone, with title, last-changed and created columns that double as sort
controls; unstamped entries sort last rather than blanking the list.

## Configuration and routes

Four values are baked in at build time as defines — hub URL, signing secret,
workspace and the workspace list — and a served `/uberblick-config.json`
document overrides the endpoint and the workspace list at runtime, per key. The
document is fetched same-origin with a three-second deadline, never rejects,
and is refused if it is not a JSON object or if it plainly names either key
twice. No room is acquired before the endpoint has settled.

Routes are hand-rolled over the History API: the root resolves to the first
configured workspace, `/<workspace>` lists it, `/<workspace>/all` is the
all-docs view, and `/<workspace>/<docUuid>` opens a document. A decorated
workspace spelling is kept in the address and parsed down to a uuid before it
reaches a room key.

The signing secret is compiled into the bundle. That is why a bundle is only
served over loopback or a private tailnet, and why removing it is a step on the
workspace-isolation ladder.

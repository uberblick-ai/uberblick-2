---
uuid: 8727c914-c462-410a-bff4-0d2975d1dbcc
title: Collaboration and presence
tags: [feature]
links: [9b4ea859-8304-4e11-9cc8-76232c16a4e5, bea0f13c-5ba9-4fb6-af7b-d627b4807786, 026e1af0-3dca-4c55-9c8b-eead5818fc89, 5238bd29-f9d5-43e8-ad40-2f039c705521, f1f403e6-fb4b-4e95-b12f-4fc0df8f4957]
---

Every client — browser tab or agent — joins the same rooms on the same
Hocuspocus hub, publishes awareness, and keeps working when the hub goes away.

## What a peer sees

- A named, coloured caret in the prose, drawn from the peer's awareness cursor.
- A chip per peer in the status line, and a row per session in the sync panel.
- An activity pill naming the session and the block number its caret is in.
- A count of connected non-browser sessions, asked of the workspace's directory room because every session joins it.

An agent is told apart from a browser only by the absence of a `client: "web"`
awareness field. There is no positive agent marker, so a browser tab that has
not reloaded since that field shipped counts as an agent until it does.

## Presence identity

A browser tab picks a random two-word name and one of eight colours per tab,
neither persisted. The colour — and only the colour — can be overridden in the
user menu, stored in that browser, and republished to every open room. An
agent session publishes the name and colour the MCP server derives from its
session id.

Identity is self-asserted today. Nothing verifies that a peer is who its
awareness state says it is.

## When the hub goes away

- The web client keeps editing against its IndexedDB replica; the MCP server keeps editing against its update log. Both converge on reconnect.
- A hub restart loses nothing: the hub flushes pending stores before it closes, and anything it never wrote is re-sent by the clients that hold it.
- The MCP server's reconnect backoff is deliberately tighter than the library default, so a document created offline is not stranded.
- `sync_status` and `ub status` distinguish six hub states: `disabled`, `connecting`, `connected`, `hub-down`, `auth-failed` and `quarantined`. A rejected token is never confused with an unreachable hub, and the hub's own wording for a rejection is discarded rather than echoed back to you.

## Remote edits in the editor

Remote changes arrive as ordinary Yjs updates. The editor animates them —
struck-through removals, a retreating veil over insertions with an agent caret
at its edge — and briefly marks the blocks that changed. The animation is
purely a rendering: the document is never the animation, and a reader typing
into a block wins over it immediately.

## Limits

- One shared signing secret authenticates every participant, so presence is not attribution: any holder can publish any name.
- Awareness carries no record of what a session last did, so the activity pill reads a cursor position rather than an action.
- The typing animation has no per-session attribution, so concurrent agents share one queue.

---
uuid: 8727c914-c462-410a-bff4-0d2975d1dbcc
title: Collaboration and presence
tags:
  - feature
links:
  - 8865aba4-fc8b-4050-a8d2-9c851be0bed3
  - 7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8
  - f1f403e6-fb4b-4e95-b12f-4fc0df8f4957
  - 9b4ea859-8304-4e11-9cc8-76232c16a4e5
---

Every client is a peer on the same Hocuspocus hub, publishes a named cursor, and
keeps a local replica so it survives the hub going away.

## Live co-editing

- The Tiptap editor binds the document's `blocks` fragment through
  y-prosemirror, so a remote change and a local change reach the screen the same
  way.
- One WebSocket per tab, multiplexed across rooms: a tab is in the directory room
  and whichever document is open.
- Room connections are refcounted by room name, so two views of one document
  share one connection.

## Presence

- Each tab publishes an awareness user: a two-word name and one of eight
  6-digit hex colours.
- Remote cursors and selections render inline in the editor, labelled with that
  name.
- Identity is generated once per page load, so two windows are two participants.

## Offline and reconnect

- Each room has a y-indexeddb replica alongside the provider; the editor pane
  shows "local cache" once it has loaded.
- The pane shows "offline" when disconnected and a count of updates applied
  locally but not yet acknowledged.
- A hub restart reloads each room from SQLite; clients reconnect, replay their
  unacknowledged updates, and converge.
- The auth token is passed as a callable, so a reconnect mints a fresh one
  instead of failing.

## Known limits

- Hub writes are debounced — Hocuspocus defaults of 2 seconds, 10 seconds
  maximum. `flush()` runs on `stop()` and on SIGINT/SIGTERM, so a graceful stop
  loses nothing, while `kill -9` can lose the debounce window.
- One shared dev secret authenticates every client, and the web bundle contains
  it. The hub binds loopback by default for that reason.
- Awareness identity is self-asserted by the client, not derived from token
  claims.

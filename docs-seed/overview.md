---
uuid: 3231bff4-fb3c-4195-a83a-98031551ca68
title: Overview
tags: [start-here]
links: [7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8, 8865aba4-fc8b-4050-a8d2-9c851be0bed3, b1d5d904-c8b6-46a1-a4df-22251875bcdb, 8727c914-c462-410a-bff4-0d2975d1dbcc, 2e8de409-df1b-4716-b6a9-71fa2ccd2aca, bea0f13c-5ba9-4fb6-af7b-d627b4807786, f1f403e6-fb4b-4e95-b12f-4fc0df8f4957, 9b4ea859-8304-4e11-9cc8-76232c16a4e5]
---

uberblick is a local-first collaborative document system in which every document
is a Yjs CRDT, agents write through MCP tools, and a web editor is one more
client on the same sync channel.

## What it is

- Documents are Yjs CRDTs synced by a Hocuspocus hub that persists them to SQLite through `node:sqlite`.
- Agents are primary readers and writers, over nineteen block-scoped MCP tools.
- The web client is a Tiptap editor bound directly to the document's blocks.
- Every document lives in a room named `<workspaceUuid>/<docUuid>`; discovery is itself a synced document.

## Who it is for

- Agents that must read and edit prose without clobbering a human's cursor.
- People who want to watch an agent edit a document live, and edit alongside it.
- One person on their own machines today: a workspace is a uuid, the hub's only credential is a shared development signing secret, and there are no accounts.

## What it is not

- Not markdown storage. Markdown is an export format; the reader that brings seed documents in is one-way and is not exposed as a tool.
- Not a whole-document writer for agents. Every agent write touches one block, and no whole-document replace tool exists.
- Not a wiki with paths. Links and identity are UUIDs; titles are display data.
- Not multi-user or hosted. There are no accounts, no permissions, no OAuth, and the workspace boundary is a namespace rather than an enforced one.

## Where to go next

- Install and run, then Concepts.
- One feature document each: Editing and blocks, Collaboration and presence, Annotations, Agents and MCP tools.
- Test protocols to verify it; Architecture for the map of the whole system, and the documents tagged `implementation-reference` for the code-level detail.

---
uuid: f1f403e6-fb4b-4e95-b12f-4fc0df8f4957
title: Test protocols
tags: [verify]
links: [8727c914-c462-410a-bff4-0d2975d1dbcc, bea0f13c-5ba9-4fb6-af7b-d627b4807786, b1d5d904-c8b6-46a1-a4df-22251875bcdb, e6609049-7917-42ac-8ab3-f068aed2a707, 7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8]
---

One runnable protocol per acceptance criterion, each with the outcome that
counts as a pass. Run them against a stack started by `mise run dev` with an
MCP client registered.

## 1. Two clients co-edit

Open the same document in two browser tabs. Type in both at once, in different
paragraphs and then in the same one.

Pass: no keystroke is lost in either tab, and each tab shows the other's caret
with its name and colour.

## 2. An agent edit lands live

With a document open in a tab, have an agent call `edit_block` on a block you
can see.

Pass: the text changes in the tab without a reload, the changed block is
briefly marked, and an agent cursor is visible with the agent's name.

## 3. A concurrent edit to another block merges

Type into block A in the tab while the agent calls `edit_block` on block B.

Pass: both changes are present afterwards, in both clients.

## 4. A conflicting edit fails safely

Read a block with `get_doc`, edit that block in the tab, then have the agent
call `edit_block` with the text and `rev` it read before your edit.

Pass: the call fails with `stale_block`, carrying `currentText` and
`currentRev`; nothing in the document changed; re-reading and calling again
succeeds.

## 5. Search and backlinks after edits

Add a distinctive word to a block and set another document's `links` to this
document's uuid.

Pass: `search` finds the word; `backlinks` on this document names the other
one; both without restarting the server.

## 6. Markdown export

Call `export_markdown` on a document holding a heading, a list, a quote, a
table, a fenced code block and a mermaid block.

Pass: fences are closed and tagged, the list numbers correctly, the table comes
back verbatim, and re-importing the output produces byte-identical markdown.

## 7. Hub restart loses nothing

Edit from both clients, then stop the hub and start it again.

Pass: both clients reconnect, every edit is still there, and `sync_status`
reports `connected` with no pending rooms.

## 8. Every tool works with the hub down

Stop the hub. Call `create_doc`, `insert_block`, `edit_block`, `list_docs`,
`search` and `export_markdown`.

Pass: all of them succeed; mutating calls report `applied: true` and `synced:
false`; `sync_status` says `hub-down` and names the endpoint. Start the hub
again: the new document appears in the other client.

## 9. A fresh client hydrates

Point a second machine — or a fresh database path — at the same hub and
workspace.

Pass: after the directory room syncs, `list_docs` returns the whole corpus and
`search` finds text in documents this replica never wrote.

## What is machine-checked instead

The repository's own suites cover the layers underneath these: `mise run test`
for every package, `mise run e2e` for the browser proof points, and `mise run
fue` for the documented install path on a clean machine.

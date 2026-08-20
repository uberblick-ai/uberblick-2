---
uuid: f1f403e6-fb4b-4e95-b12f-4fc0df8f4957
title: Test protocols
tags:
  - verify
links:
  - 7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8
  - b1d5d904-c8b6-46a1-a4df-22251875bcdb
  - 8727c914-c462-410a-bff4-0d2975d1dbcc
  - bea0f13c-5ba9-4fb6-af7b-d627b4807786
---

Nine protocols, one per spike acceptance criterion, each a sequence with a stated
expected outcome. Start from a running stack — see Install and run.

## 1. Two clients co-edit

Open one document in two windows. Type a sentence in each, alternating. Expect
every keystroke present in both, and a named remote cursor visible in each.

## 2. An agent edit lands live

With both windows open, call `edit_block` from an MCP client on a visible block.
Expect the new text in both windows within a second, and the agent's cursor
labelled in the presence list.

## 3. Concurrent edit to a different block merges

Type in block A in a window while an agent edits block B. Expect both edits
present, neither truncated.

## 4. Conflicting edit to the same range fails safely

Read a block's text and `rev`, type into that block in the browser, then call
`edit_block` with the stale values. Expect a staleness error carrying the current
text and rev, no document change, and success after re-reading.

## 5. Search and backlinks after edits

Insert a distinctive word, set `links` to another document's UUID, then call
`search` for the word and `backlinks` for that UUID. Expect the edited document
in both results.

## 6. Markdown export

Call `export_markdown` on a document holding all four block types. Expect
frontmatter, headings as hashes, a code fence tagged with its language, and a
fence tagged mermaid.

## 7. Hub restart loses nothing

Stop the hub with SIGINT, restart it. Expect every document unchanged, and a
client that edited while it was down to converge on reconnect.

## 8. Hub down, agent still works

Kill the hub. Call every MCP tool, including `create_doc`. Expect all to succeed
with `synced` false. Restart the hub and expect both the new document and the
edits to appear in a browser window.

## 9. Fresh client hydrates

Clear a browser profile's IndexedDB, or use a new profile, and connect. Expect
the full document list and correct search results after sync.

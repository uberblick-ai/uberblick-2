# docs-seed

The bootstrap snapshot of the product documents. A **new** workspace boots from
these files; an **initialised** workspace's live documents are authoritative,
and re-importing never overwrites a uuid that already exists there.

That is the whole policy, and it has three consequences worth stating plainly:

- **Live documents win.** Once `mise run import-seed` has run, the documents
  live inside uberblick and are read and written through the MCP tools. The
  importer cannot tell an edited seed file from a legitimately edited document,
  so on a re-run it writes nothing and reports every document `unchanged`.
- **These files are current, not history.** They are a snapshot of the corpus
  as it stands, not a frozen record of how it started. A change to the status
  quo updates its seed file **before** the merge — through
  `export_markdown`, which is what a seed file is — and the live document
  **after**, through the MCP tools.
- **Re-import is safe and is not a sync.** There is no two-way
  synchronisation, and nothing here can overwrite an initialised workspace.
  Changing a seed file changes what a *fresh* workspace boots with.

This README is the exception, and is not itself imported: it documents the seed
format and carries the convenience index below.

## The file format

Every file except this README carries YAML frontmatter with four keys:

- `uuid` — pre-assigned, lowercase. Identity is uuids everywhere, and the
  importer never invents one: a generated uuid would make every re-run a new
  document.
- `title` — the display title.
- `tags` — exactly one of `start-here`, `feature`, `verify`, `reference`,
  `implementation-reference`.
- `links` — uuids of related seed documents, seeding the backlink graph. The
  exporter does not emit this key, so it is the one line a refreshed file
  carries over by hand.

Bodies carry no H1: the importer consumes a leading H1 only when frontmatter
has no `title`. They may use any of the seven block types the schema
owns — paragraph, heading, code, mermaid, list-item, quote and table.

**A list item must be one line.** The markdown reader has no lazy
continuation, so a wrapped item comes back as an item plus an indented
paragraph, and emphasis spanning the wrap comes back escaped. Long lines are
the price of a snapshot that round-trips.

`scripts/docs-seed-check.mjs` — run by `mise run test` — fails when a file
lacks its uuid, title or tag, when a uuid is malformed or claimed twice, when a
link names no seed document, or when a document tells the reader to run a
`mise run` task that `mise.toml` no longer defines.

## Doc UUIDs

Where issue authors look up a uuid for a Pointer, cited as `title (uuid)` — see
`.github/ISSUE_SPEC.md`.

Generated from `list_docs` on 2026-08-26, after the fresh-start regeneration
into the uuid workspace. **`list_docs` is the authority; this table is a
convenience snapshot and may lag.** Every row has a seed file, and every seed
file has a row.

| Title | UUID | Hook |
| --- | --- | --- |
| Agents and MCP tools | `bea0f13c-5ba9-4fb6-af7b-d627b4807786` | The nineteen MCP tools, block-scoped writes, the stale-read check, and honest durability. |
| Annotations | `2e8de409-df1b-4716-b6a9-71fa2ccd2aca` | Comment threads anchored by a formatting mark rather than by positions. |
| Architecture | `9b4ea859-8304-4e11-9cc8-76232c16a4e5` | The map of the whole system — and the workspace-isolation mechanism, decided and not yet built. |
| Awareness and cursor wire formats | `026e1af0-3dca-4c55-9c8b-eead5818fc89` | The exact awareness payload a client must publish to appear, and be attributed, in the editor. |
| Collaboration and presence | `8727c914-c462-410a-bff4-0d2975d1dbcc` | Peers on one hub: live co-editing, named cursors, and what happens when the hub goes away. |
| Concepts | `8865aba4-fc8b-4050-a8d2-9c851be0bed3` | The shared vocabulary the other documents use with these exact meanings. |
| Decisions | `6ea21fbd-aef9-4e69-873e-6c2a182e8894` | Standing decisions that govern current work, and where each one binds. |
| Editing and blocks | `b1d5d904-c8b6-46a1-a4df-22251875bcdb` | The flat block list, the seven block types, and why every write touches one block. |
| Install and run | `7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8` | Two commands from a clean machine to a running stack, and what `ub init` creates. |
| MCP server internals | `06777f59-3159-4511-8236-8fc66d70da27` | The update log, compaction, the derived index, and what `applied` versus `synced` each guarantee. |
| Overview | `3231bff4-fb3c-4195-a83a-98031551ca68` | What uberblick is, who it is for, and what it deliberately is not. |
| Remote server setup | `4575a744-1656-4699-af69-980a05d15fcc` | Hub and web client on a remote Linux host inside a tailnet, and the deliberate-update rule. |
| Schema API reference | `8a070124-2dc6-442a-8ea9-6db5b63ca950` | Function-level reference for `@uberblick/schema`, the package every other one imports. |
| Test protocols | `f1f403e6-fb4b-4e95-b12f-4fc0df8f4957` | One runnable protocol per acceptance criterion, each with its expected outcome. |
| Testing patterns | `e6609049-7917-42ac-8ab3-f068aed2a707` | The testing idioms this codebase already has, and the bar a new test must clear. |
| Web editor internals | `5238bd29-f9d5-43e8-ad40-2f039c705521` | What a web-editor change must never do, and where the Tiptap machinery lives. |

`ub init` also seeds two starter documents into an otherwise empty workspace:
Welcome (`2d56b281-5614-43bd-b8d8-edd1c270a85a`) and Bring your docs in
(`d7ddd0b1-fee9-4ef0-8f1e-42882f925c31`). They live in
`packages/cli/templates/`, carry those uuids in every workspace, and are not
part of this snapshot — `mise run import-seed` neither writes nor touches them.

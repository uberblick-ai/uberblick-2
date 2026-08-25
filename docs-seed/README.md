# docs-seed

One-time import source for the product docs (CLAUDE.md's dogfooding contract).
Once the importer has run the docs live inside uberblick, edited through the MCP
tools; these files are never edited again.

Every file except this README carries YAML frontmatter: `uuid` (pre-assigned,
lowercase — identity is UUIDs everywhere), `title`, `tags` (exactly one of
`start-here`, `feature`, `verify`, `reference`), and `links` (UUIDs of related
seed docs, seeding the backlink graph). Bodies carry no H1 — `importMarkdown`
consumes a leading H1 only when frontmatter has no `title` — and use only
heading, paragraph, code and mermaid blocks, the four the schema supports.

## Doc UUIDs

Where issue authors look up a uuid for a Pointer, cited as `title (uuid)` — see
`.github/ISSUE_SPEC.md`. Not every row has a seed file: the docs live inside
uberblick now, and several were created there after the import.

Generated from `list_docs` on 2026-08-25. **`list_docs` is the authority; this
table is a convenience snapshot and may lag** — docs created, retitled or
deleted since that date are not reflected here. Rows are in `list_docs` order.

| Title | UUID | Hook |
| --- | --- | --- |
| *(untitled)* | `00234fff-82aa-43c1-b090-82e5a08e8e86` | Scratch doc from the first hub-synced co-editing session; never titled. |
| Agents and MCP tools | `bea0f13c-5ba9-4fb6-af7b-d627b4807786` | The MCP stdio server agents talk to: the tool set, block-scoped writes, the stale-read check. |
| Annotations | `2e8de409-df1b-4716-b6a9-71fa2ccd2aca` | Comment threads anchored by a formatting mark rather than by positions. |
| Architecture | `9b4ea859-8304-4e11-9cc8-76232c16a4e5` | One Y.Doc per document, one room per Y.Doc, every index derived rather than trusted. |
| Awareness and cursor wire formats | `8034a2b4-833c-4256-8c35-d12e25c3a9fa` | The exact awareness payloads a client must publish to appear, and be attributed, in the editor. |
| Collaboration and presence | `8727c914-c462-410a-bff4-0d2975d1dbcc` | Peers on one Hocuspocus hub: live co-editing, named cursors, surviving the hub going away. |
| Concepts | `8865aba4-fc8b-4050-a8d2-9c851be0bed3` | The shared vocabulary the other docs use with these exact meanings; tagged `archive`. |
| Decisions | `2a5f6127-7cda-4da4-9da5-6b782cd216f2` | Standing owner decisions that govern current work, and where each one binds. |
| Editing and blocks | `b1d5d904-c8b6-46a1-a4df-22251875bcdb` | The flat block list, the four block types, and why every write touches one block. |
| Install and run | `7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8` | Getting the stack running locally: mise, the age key, the hub and web dev server. |
| MCP server internals | `e48e993c-c0d1-498a-894f-031dc293434b` | How the MCP server holds data, and what `applied` versus `synced` each guarantee. |
| Overview | `3231bff4-fb3c-4195-a83a-98031551ca68` | What uberblick is, who it is for, and the problem it exists to solve. |
| Remote server setup | `f8535686-b07a-47f0-9e79-c2720f155fae` | Running hub and web client on a remote Linux host inside a tailnet, via Docker Compose. |
| Schema API reference | `760b661a-6eae-475c-9fed-a4cafa902331` | Function-level reference for `@uberblick/schema`, the package every other one imports. |
| Test protocols | `f1f403e6-fb4b-4e95-b12f-4fc0df8f4957` | One runnable protocol per spike acceptance criterion, each with its expected outcome. |
| Testing patterns | `9586c82d-bfbe-4b45-be33-5fbc3c63ec5d` | The testing idioms this codebase already has, and the bar a new test must clear. |
| Web editor internals | `60c1b345-43f3-4b39-8f3a-e6d39aa7107d` | What a web-editor change must never do, and where the Tiptap machinery lives. |

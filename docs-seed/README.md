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

# uberblick

A local-first, CRDT-backed collaborative document system. MCP-first: agents are
primary readers and writers; the web UI is a viewer/editor. Yjs CRDTs, a
Hocuspocus sync hub with SQLite persistence, an MCP server with a local SQLite
mirror (FTS5, tags, backlinks), and a BlockNote web client.

## How to run things

Tasks are the only documented way to run anything. Never invoke `pnpm` directly
in docs, README, or CI.

- `mise run hub` — start the Hocuspocus sync hub
- `mise run mcp` — start the MCP server
- `mise run web` — start the Vite dev server
- `mise run dev` — all three
- `mise run test` — run the test suites

Secrets come from `fnox exec` (age-encrypted `fnox.toml`, safe to commit; the
private key lives at `~/.config/fnox/age.txt`, never in the repo). The mise
tasks already wrap their commands in `fnox exec` — do not write secrets to
`.env` files or commit plaintext tokens.

## Orchestration policy

Work in this repo is always done by sub-agents, spawned as Opus. Fable (the
coordinating model) is there to coordinate, validate, and make the right
decisions — it does not write feature code itself. Code lives in sub-agents and
workflows: delegate implementation to Opus sub-agents (or Workflow pipelines
for fan-out), then validate their output (run tests, check acceptance criteria)
before moving on.

## Architecture (decided — do not relitigate)

- TypeScript everywhere; single pnpm monorepo.
- One Y.Doc per document; room name = document UUID.
- Doc layout: `meta` (Y.Map: uuid, title, tags, links-by-UUID), `blocks`
  (block sequence with stable block IDs; types: paragraph, heading, code,
  mermaid), `annotations` (Y.Map of threads anchored via Yjs relative
  positions). Links reference UUIDs, never paths or titles.
- `packages/schema` is the keystone; everything imports it. Its only runtime
  deps are `yjs` and a diff library.
- Agent edits are block-scoped, never document-scoped. `edit_block` does
  diff-and-splice on one block's Y.Text and fails safely when `old_text` is
  stale. A whole-document replace tool must not exist.
- Markdown is an export format, never the storage format.
- Every client publishes awareness (name, color, cursor); agent sessions are
  visible in the UI.

## The dogfooding contract

The document system stores the status quo of the product — what exists, how it
behaves, its limits — and may run slightly ahead of the code only where a doc
explicitly says so. It contains:

1. **Product definition** — what uberblick is, who it is for, what it
   deliberately is not.
2. **Features & limitations** — one doc per feature area: current behavior and
   known limits.
3. **Test protocols** — how to verify each feature area, written so an agent
   can execute them.
4. **Technical reference** — schema package API, MCP tool contracts, doc model,
   architecture. Written for LLMs: front-loaded summaries, stable terminology,
   links by UUID.

Changes do not live in the docs. Anything describing a delta — bugs, planned
work, proposals — is extracted to GitHub issues/projects/PRs. When work merges
and the status quo shifts, the doc is updated to the new status quo. Docs
answer "what is true now"; GitHub answers "what is changing."

**Agent workflow:** read the relevant docs → compare against the code → the gap
is the work → do the work via a GitHub-style change → update the doc to the new
status quo.

Once the uberblick MCP server is registered (`.mcp.json`), read and update the
product docs through its tools — never by editing `docs-seed/` files, which are
only the one-time import source.

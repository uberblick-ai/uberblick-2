# uberblick

A local-first, CRDT-backed collaborative document system. MCP-first: agents are
primary readers and writers; the web UI is a viewer/editor. Yjs CRDTs, a
Hocuspocus sync hub with SQLite persistence, an MCP server with a local SQLite
mirror (FTS5, tags, backlinks), and a Tiptap web client (custom nodes over the
schema-owned block shape — decided over BlockNote, which rewrites foreign
fragment shapes and strips undeclared attributes).

## How to run things

Tasks are the only documented way to run anything. Never invoke `pnpm` directly
in docs, README, or CI.

- `mise run hub` — start the Hocuspocus sync hub
- `mise run mcp` — start the MCP server
- `mise run web` — start the Vite dev server
- `mise run dev` — all three
- `mise run test` — run the test suites

Secrets and endpoints come from `fnox exec` (age-encrypted `fnox.toml`, safe
to commit; the private key lives at `~/.config/fnox/age.txt`, never in the
repo). The mise tasks already wrap their commands in `fnox exec` — do not
write secrets to `.env` files or commit plaintext tokens.

Config: `HUB_AUTH_TOKEN` stays encrypted in fnox. `HUB_URL` is plaintext
config (mise `[env]`, default `ws://localhost:1234`) — an endpoint is not a
secret, and contributors without the age key must still be able to run the
stack. The hub binds `PORT` (default 1234); `HUB_URL` is client-side only.
Rule: no hardcoded hub addresses anywhere except the in-code fallback default.

## Orchestration policy

Work in this repo is always done by sub-agents, spawned as Opus. Fable (the
coordinating model) is there to coordinate, validate, and make the right
decisions — it does not write feature code itself. Code lives in sub-agents and
workflows: delegate implementation to Opus sub-agents (or Workflow pipelines
for fan-out), then validate their output (run tests, check acceptance criteria)
before moving on.

## Architecture (decided — do not relitigate)

- TypeScript everywhere; single pnpm monorepo.
- One Y.Doc per document; room name = `<workspaceId>/<docUuid>`, directory at
  `<workspaceId>/_directory`. One configured workspace for now (`WORKSPACE_ID`,
  default `main`) — tenancy lives in the room key from day one so a hosted hub
  never needs a room migration.
- Doc layout: `meta` (Y.Map: uuid, title, tags, links-by-UUID), `blocks`
  (Y.XmlFragment, one element per block with stable `id` attrs; types:
  paragraph, heading, code, mermaid), `annotations` (Y.Map of thread JSON;
  ranges are anchored by a `comment` formatting mark carrying the threadId on
  the block's Y.XmlText — marks survive splits, re-types, and concurrent
  edits, unlike relative positions). Links reference UUIDs, never paths or
  titles.
- `packages/schema` is the keystone; everything imports it. Its only runtime
  deps are `yjs` and a diff library.
- Agent edits are block-scoped, never document-scoped. `edit_block` does
  diff-and-splice on one block's text and fails safely when `old_text` or the
  per-block `rev` (content hash returned by every read) is stale. The
  guarantee is local-replica-only — there is no cross-replica CAS, and it
  weakens offline; document that, don't hide it. A whole-document replace tool
  must not exist.
- The web editor is Tiptap + y-prosemirror with custom nodes matching the
  schema-owned shape; the block palette is restricted to the four block types;
  unknown blocks degrade loudly (visible placeholder, explicit export marker),
  never silently dropped.
- Markdown is an export format, never the storage format.
- Every client publishes awareness (name, color, cursor); agent sessions are
  visible in the UI.
- Discovery is itself a synced doc: a directory doc in a well-known room
  (`_directory`) holds a Y.Map of uuid → {title, tags, deleted?} stubs,
  upserted on create/rename and tombstoned on delete. `list_docs` is fed by
  the directory doc, never by locally-observed creations.
- The MCP server is offline-first by construction, not emergently: the
  append-only update log is the authoritative local replica (replicas hydrate
  from it on boot, never from the hub); the server starts and serves every
  tool with the hub unreachable; writes apply locally and return before hub
  ack — sync is background.

## Hosted future (directional — shapes cheap-now choices only)

The hub will eventually be hosted commercially with multiple workspaces and
multiple user accounts (OAuth sessions). Spike consequences, nothing more:
rooms carry `workspaceId` from day one; the auth token is claims-shaped
(`{sub, workspace, scope}`, HMAC-signed with a dev secret for now) rather than
an opaque shared string, and is sent via Hocuspocus's auth message, never in
the WebSocket URL query string; awareness identity should derive from token
claims eventually, not self-assertion. No OAuth, permissions, or multi-user
auth in the spike itself.

## Invariants

- SQLite indexes (FTS5, tags, links) are derived and rebuildable — never
  authoritative.
- All document state lives in the Y.Doc, never in server-side tables.
- Identity is UUIDs everywhere; titles and paths are display data. On
  conflict, `meta.title` in the doc is authoritative; the directory stub is a
  cache repaired on write/connect.
- Discovery is itself a synced doc (the `<workspaceId>/_directory` room),
  traveling over the same sync channel — and logged/hydrated offline like any
  other doc.
- Block-type changes preserve the block ID and the text delta (marks
  included) — `setBlockType` is the only sanctioned re-type; never plain
  delete+reinsert, which churns IDs and orphans anchors.
- One update encoding everywhere: Yjs v1 (`encodeStateAsUpdate`/`applyUpdate`)
  across the MCP update log, hub persistence, and snapshots. Never mix v1/v2.
- The MCP update log records every update, local AND remote origin,
  synchronously before the mutating call returns.
- Exactly one `yjs` module instance per process: `yjs` is a peerDependency of
  schema, pinned via pnpm catalog/overrides.
- The MCP server writes nothing to stdout except JSON-RPC — logging is
  stderr-only (stdout is the transport).
- Mutating MCP tools report durability honestly: `{applied, synced}` — applied
  locally is not synced.

## Spike acceptance criteria

- Web UI and a second client co-edit a doc with visible remote cursors, no
  lost keystrokes.
- An `edit_block` from an MCP client lands in the web UI live, attributed to a
  visible agent cursor.
- A concurrent human edit to a different block merges cleanly; a conflicting
  edit to the same range makes `edit_block` fail safely with a re-read.
- `search` and `backlinks` return correct results from the derived index after
  edits.
- `export_markdown` produces clean markdown including fenced code and mermaid.
- The system's own docs are inside it, and an agent has demonstrably used the
  MCP tools to update one of them.
- Hub restart loses nothing; a client offline during edits converges on
  reconnect.
- Kill the hub mid-session — every MCP tool still works, including creating a
  doc; restart the hub — everything converges, including on a second client.
- A fresh client with empty local state connects to the hub and can enumerate
  and search all existing docs after hydration.

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

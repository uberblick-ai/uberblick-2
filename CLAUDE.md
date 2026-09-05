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
- `mise run dev` — hub + web (the MCP server is stdio — its client spawns it)
- `ub env -- <command…>` — run anything under this machine's uberblick
  configuration; how the tasks above get theirs
- `mise run lint` — Biome lint (lint only; the formatter is off by decision)
- `mise run test` — run the test suites
- `mise run e2e` — the browser proof points (Playwright, Chromium, on demand;
  starts its own hub and dev server on ephemeral ports, so it needs no secret)

Every task that needs uberblick's configuration wraps its command in
`fnox exec -- ub env -- …`. `ub env -- <command…>` execs a command under exactly
the environment `ub` resolves — `WORKSPACE_ID`, the hub endpoint and the signing
secret — which is the same map `ub mcp serve` hands the MCP server, so a task
and an agent's server are never configured differently. There is deliberately
**no bare `ub env`**: printing the resolved environment would print the signing
secret. A checkout is not a configuration layer, and nothing is written into
one.

Secrets come from `fnox exec` (age-encrypted `fnox.toml`, safe to commit; the
private key lives at `~/.config/fnox/age.txt`, never in the repo) — do not write
secrets to `.env` files or commit plaintext tokens.

Config: `HUB_AUTH_TOKEN` stays encrypted in fnox and may also come from the
environment. **The hub endpoint has exactly one authority: this machine's
`config.json`**, written by `ub init` and `ub remote join`. `HUB_URL` in the
environment is not read and is not passed to a child — two ambient sources for
an endpoint is what silently redirected a bound workspace at a local hub while
reporting `synced` (#376, #385). The in-code fallback default is
`ws://localhost:1234`; the hub binds `PORT` (default 1234) and never reads the
endpoint. Rule: no hardcoded hub addresses anywhere except that in-code default.

## Orchestration policy

`AGENTS.md` is the canonical agent-neutral workflow for every implementer lane,
and `.agents/roles/` defines three continuous entry roles (`issue-preparer`,
`implementer`, `integrator`) and two exact-key internal roles; there is no
coordinator role — a program is a milestone plus `umbrella` parents, ordered
by `Depends-on` and dispatched by the ordinary queues (owner decision,
2026-09-04). Every contract is runtime-neutral: a role runs as a Codex
session or a Claude session, started by `ub launch <role> --codex|--claude`,
and its runtime shows
only in the run id and the claim. The implementer's default runtime is Codex.
Implementers run in isolation under the same claim, handoff and review rules.
An entry role self-picks under its contract; an internal child follows its
parent's durable exact-key assignment and never searches a queue. No session
reviews or merges a diff it authored, and a challenge of a diff always runs on
a session that did not write it.

Issue shaping is a separate conversation entry point: the Codex and Claude
`shape-issue` adapters both read `.agents/protocols/issue-shaping.md` and may
create only a confirmed `needs-preparation` intake. Preparation still begins in
the issue-preparer role and follows `.agents/protocols/issue-preparation.md`;
neither shaping nor its adapters grant `ready` or choose Priority.

## Development workflow (every functionality)

1. **Issue first.** Every piece of functionality starts as a GitHub issue:
   what, why, acceptance criteria. No issue, no branch. Issues the
   implementation loop may pick up must conform to `.github/ISSUE_SPEC.md`
   (`Depends-on`/`Touches` header, runnable acceptance criteria, explicit
   out-of-scope); the `ready` label asserts conformance and eligibility.
2. **Branch + implementer agents.** Implementation happens on a feature branch
   (`feat/<slug>`, `fix/<slug>`), written by isolated implementer agents that
   claim their own issue in `.github/ISSUE_SPEC.md`'s grammar under
   `.agents/roles/implementer.md`. Never commit feature work directly to
   `main`.
3. **PR.** Open a PR against `main` linked to the issue (`Closes #N`), with a
   body stating what changed and how it was verified.
4. **Gates — all of them, before merge.** Effort follows semantic risk. Paths
   and line counts are inspection signals, not automatic extra rounds; link
   exact-head evidence instead of repeating it:
   - immutable review green at the exact merge head. The Docker review
     (`mise run review <head-sha>`, from a trusted checkout of `origin/main`)
     is required when the diff touches persistence, synchronization,
     concurrency, process lifecycle or auth, when a challenge round is owed,
     when `main` moved under the PR, or when CI is not green at that head;
     otherwise, for tier 1, CI's `gates` check run at `headRefOid` is the
     immutable review — verify its conclusion at that SHA and link it, since
     nothing enforces it (owner decision, 2026-09-02). Worktree tests are
     useful during implementation but are never merge evidence, because a
     shared checkout can change during review;
   - integrator validation against the issue's acceptance criteria;
   - **independent implementation challenge, proportionate to semantic risk.**
     First the exemption: a test-only, docs-only or narrowly mechanical diff
     that preserves production behavior owes **no** challenge when focused
     validation directly proves the contract — the implementer writes
     `Challenge: none owed (<reason>)` in its handoff and dispatches nothing,
     and the integrator dispatches nothing either. Otherwise two challenges
     are required when the diff changes schema meaning,
     persistence, synchronization, concurrency, auth, runtime dependencies, or
     decided architecture, or when the implementer or integrator names a
     concrete unresolved risk warranting both perspectives: first a fresh
     `implementation-reviewer` on the other runtime from the diff's author,
     delegated by the implementer before handoff; then a separate
     `implementation-reviewer` on the author's runtime in a fresh session,
     delegated by the integrator. Both challenges target the same frozen
     candidate head before ordinary P2/P3 corrections: the implementer hands
     off the first verdict without changing that head, the integrator obtains
     the second, and one ruling batches both sets of findings. A P1 may break
     the freeze; its corrected head re-establishes the required independent
     evidence before merge. One implementer-owned cross-runtime
     challenge is enough when an outside read is useful but those boundaries
     do not fire. Every
     challenge actively hunts for counterexamples, missing failure paths,
     incorrect assumptions, overengineering and overtesting; integrator gate
     work and Copilot do not substitute for a required challenge;
   - **zero unaddressed PR remarks** — immediately before merging, re-fetch
     the PR's reviews and comment threads (human and bot alike, including
     remarks that arrived after the other gates passed); merge only when
     every remark is fixed or explicitly answered.
   Findings are triaged into an explicit disposition: fixed on the branch;
   deferred to a linked issue with the accepted risk recorded on the PR
   (never for data loss, auth/security exposure, or a violated invariant);
   create that issue through `.github/ISSUE_SPEC.md`'s **Request source** path;
   accepted as debt on the PR when P3, or when a P2's claimed impact remains
   theoretical because no current supported-usage failure is established; or,
   under that theoretical condition, closed `wontfix` if already an issue. Both
   record the consequence and disproportionate delivery cost;
   documented as an out-of-usage-model boundary; or rejected with an
   explicit reply on the PR thread — never silent dismissal. A concrete bug
   observed later is new evidence and may be filed or reopened then.
   GitHub Copilot is optional additional evidence, not a gate. When requested,
   record a platform refusal or outage once and continue; every review remark it
   actually posts still falls under the zero-remark gate above.
   Reviewing a commit is one command, `mise run review <head-sha>`,
   run from a checkout at freshly fetched `origin/main` with `mise.toml`,
   `Dockerfile.review` and `.dockerignore` unmodified — the task refuses
   otherwise, because main is what supplies the build recipe. The reviewed
   commit contributes file contents, via `git archive`; its manifests still
   install in the networked build stage, so pass the SHA rather than checking
   the branch out, and never pass secrets, host mounts, privileged mode, or
   the Docker socket. For persistence,
   startup/shutdown, networking, concurrency, and other stateful boundaries,
   passing happy-path tests is not enough: run focused failure-path probes in
   the retained review image and post reproducible findings inline. README's
   "Review isolation" states the full boundary.
5. **Merge, then docs.** After the gates pass, merge per the merge policy
   below; then update the product docs (through the uberblick MCP tools once
   live) to the new status quo.

### Merge policy — the rules are the authority, not a session

- **Tier 1 — existing behavior only.** No change to production behavior,
  persisted state, public command or interface surface, dependencies, or
  decided architecture. This includes focused tests, documentation corrections,
  and mechanical maintenance that defend or describe an existing contract. The
  integrator merges when the ordinary gates and acceptance criteria are green;
  no merge report is owed.
- **Tier 2 — self-merge with evidence.** Production-behavior changes that meet
  neither tier 1 nor tier 3, including feature packages and backward-compatible
  additive schema work: all gates green **plus** a merge-report comment on the PR —
  acceptance criteria checked off one by one, gate outcomes, any rejected
  review findings with reasons. The integrator audits post-merge while updating
  the product docs; audit findings become issues, not reverts, unless critical.
- **Tier 3 — `needs-human`, pre-merge.** Label the PR `needs-human`, park it,
  continue with other eligible issues. The owner authorizes by swapping
  `needs-human` for `human-approved`, or explicitly directs a session to do so
  for named PRs with a provenance comment; the loop then executes that merge as
  tier 2. Every other gate remains. Triggers: a breaking or destructive schema
  change, data migration, or break in persisted-data compatibility; a change to
  CRDT or concurrency semantics; changes to this file's decided-architecture or
  invariants sections; new *runtime* dependencies; auth/token semantics;
  overruling a major reviewer finding; and process changes that alter
  authority, eligibility, merge/approval rules, or destructive automation.
  Paths identify what to inspect; they never trigger tier 3 by themselves.
- **Owner approval — one decision, not a late ceremony.** `human-approved` may
  be recorded as soon as a PR's intended shape and known findings are visible.
  It covers conforming fix-ups and non-rewriting synchronization with `main`.
  If later work materially expands the design or scope, replace it with
  `needs-human` and name the delta.
- **Tier routes authority; it does not choose the design.** Never replace a
  simpler established primitive or dependency with bespoke correctness
  machinery merely to avoid tier 3. Make the intended shape visible early and
  obtain the owner decision once; the approval can precede final gates.
- **`packages/cli` — tiered from the diff, not the package name** (owner
  decision, 2026-08-24). A diff that adds or changes the user-facing command
  surface — new subcommands, a changed user↔uberblick interaction, anything
  relevant to distribution or to new users — is tier 3; a logical extension or
  a bugfix of already-shipped CLI behavior is tier 2.

The tier-3 trigger list is the autonomy dial: Ben shrinks (or grows) it by
editing this section as the foundation stabilizes. "Gates green" is
machine-enforced by CI once it exists — until then a session's self-report is
the fallback, which is exactly why CI is high priority.

## Guiding principles

- **KISS / YAGNI.** Build the simplest thing that satisfies the issue. No
  speculative generality, no config for futures nobody scheduled.
- **Least code wins.** The goal is the smallest diff that does the job —
  prefer reusing or deleting over adding. Eagerly producing lots of code is a
  failure mode, not productivity.
- **Write code for humans.** Clarity over cleverness; names over comments;
  small reviewable units.
- **Don't overtest.** Test contracts and invariants — concurrency semantics,
  data safety, the things someone relies on — not implementation details or
  trivia. Every test must defend a behavior worth defending.
- **Boring dependencies, few of them.** Adding a dependency is an
  architectural decision, not a convenience. That bar favors a justified,
  established primitive over hand-rolling the same safety or accessibility
  contract; tier escalation is approval routing, not a reason to write more
  code.

## Architecture (decided — do not relitigate)

- TypeScript everywhere; single pnpm monorepo.
- One Y.Doc per document; room name = `<workspaceId>/<docUuid>`, directory at
  `<workspaceId>/_directory`. A workspace id is a **uuid** — globally unique,
  assigned by `ub init`, never guessable, no default. For display it may be
  decorated as `<slug>-<uuid>`; the slug is cosmetic, parsed off (schema owns
  the parse) before the id reaches rooms, token claims, or the database
  filename — nothing two machines compare ever carries a slug. Tenancy lives in
  the room key from day one so a hosted hub never needs a room migration.
- Doc layout is a closed set of four root types: `meta` (Y.Map: uuid, title,
  description, TL;DR, changelog suggestion, tags as flat per-tag presence entries,
  links-by-UUID, kind, status, and internal decision remove/add levels), `blocks`
  (Y.XmlFragment, one element per block with stable `id` attrs; types:
  paragraph, heading, code, mermaid, list-item, quote, table), `annotations`
  (Y.Map of one Y.Map per thread: anchor block, resolved flag, and the
  thread's own comments as a nested Y.Array — a comment list held inside the
  thread's replaced JSON value silently lost concurrent replies, #461), and
  `decisions` (Y.Array of decision-document UUID
  strings in stored order: the fixed decision-log slot). An older client that
  never opens an unknown root type preserves it across Yjs edit and sync; the
  loss boundary is Markdown export/import. Adding another fixed root type is a
  decided-architecture change, not an open-ended slot mechanism. Annotation
  ranges are anchored by a `comment` formatting mark carrying the threadId on
  the block's Y.XmlText — marks survive splits, re-types, and concurrent
  edits, unlike relative positions). Inline formatting rides the same
  mechanism: a closed set of Yjs text-formatting marks on the block's
  Y.XmlText — `bold`, `italic`, `strike`, `inlineCode`, `link` (external
  http(s) URLs only), `docLink` (a document uuid, never a URL or a path) —
  plus `comment`, and nothing else. The two link marks are one affordance over
  two disjoint target spaces: a write refuses a range carrying both, and
  because two Yjs keys have no cross-key exclusion, a read of a merged pair
  resolves to `docLink`. Prose blocks
  (paragraph, heading, list-item, quote) carry inline marks; `code`, `mermaid`
  and `table` are source text and carry only `comment`. A list is a *run of
  adjacent `list-item` blocks* carrying `list` (bullet|ordered) and `indent`
  (0–3) — markdown's own model, so nothing nests; a `table` stores GFM table
  markdown as its text and is rendered from it, so an agent edits a table with
  `edit_block` in the format it already writes. The mark is named
  `inlineCode` rather than
  `code` because ProseMirror forbids one name being both a node and a mark,
  and a mark's name is its Yjs key. Links reference UUIDs, never paths or
  titles — the curated doc-level list is `meta.links`, and inline doc-to-doc
  references are `docLink` marks (labels are display text, resolved once when
  the link is made).
- `packages/schema` is the keystone; everything imports it. Its only runtime
  deps are `yjs` and a diff library.
- Agent edits are block-scoped, never document-scoped. `edit_block` does
  diff-and-splice on one block's text and fails safely when `old_text` or the
  per-block `rev` (content hash returned by every read) is stale. The
  guarantee is local-replica-only — there is no cross-replica CAS, and it
  weakens offline; document that, don't hide it. A whole-document replace tool
  must not exist.
- The web editor is Tiptap + y-prosemirror with custom nodes matching the
  schema-owned shape; the block palette is restricted to the closed set the
  schema owns — paragraph, heading, code, mermaid, list-item, quote, table —
  and stock Tiptap list and table extensions are rejected, because a nested
  list or cell tree has no block-scoped text for an agent to edit; unknown
  blocks degrade loudly (visible placeholder, explicit export marker), never
  silently dropped.
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
- `ub open` is the machine's foreground serving process: one silent, exclusive
  full replica on that same store plus a loopback Hocuspocus server for the
  browser, joined only through the update log. A browser update is validated
  and appended to the log before the server may apply, acknowledge or broadcast
  it; a refused append never reaches another replica. The served configuration
  points the browser at `ub open`, names the replica's upstream separately, and
  keeps its startup binding until the process is restarted.

## Hosted future (directional — shapes cheap-now choices only)

The hub will eventually be hosted commercially with multiple workspaces and
multiple user accounts — real user auth, OAuth, with Firebase Auth a named
candidate. Spike consequences, nothing more:
rooms carry `workspaceId` from day one; the auth token is claims-shaped
(`{typ, sub, workspace, scope, kid, iat, exp}`, HMAC-signed with the single
shared secret release 1 keeps) rather than an opaque shared string, and is sent
via Hocuspocus's auth message, never in the WebSocket URL query string;
awareness identity should derive from token claims eventually, not
self-assertion. No OAuth, permissions, or multi-user auth in the spike itself.

Release 1's recorded security boundary is the tailnet: every client holds that
one signing secret, so the deployment is supported only on a private Tailscale
network (REMOTE.md) — an unguessable hostname is not a boundary. Build real
auth when the trigger fires: the first non-owner person or untrusted device on
the tailnet, or any exposure beyond it.

## Invariants

Release 1 (#379) is a flag day, and only release 1: no backward compatibility,
no data migration and no legacy detection anywhere — storage, config,
deployment, wire — and it stands up a fresh hub and a fresh workspace.

- SQLite indexes (FTS5, tags, links) are derived and rebuildable — never
  authoritative.
- All document state lives in the Y.Doc, never in server-side tables.
- **Document state syncs; auth state decides.** State that must merge between
  copies and survive offline lives in a Y.Doc. State that must be correct in
  one place at one time — which workspaces a hub serves, which credentials open
  them, which have been revoked — never lives in a synced document and is never
  rebuilt from documents: the hub must decide before it admits a connection,
  and the party being revoked is the one who controls whether its own replica
  is current. What backs it instead stays open — the hub's own non-synced
  tables, or an identity provider the hub consults — until the real-auth
  trigger fires; that decision is deferred with #388. Closed list, not a
  general licence for server-side state: the workspaces a hub serves and the
  credentials that open them, nothing else. That list is empty today — release
  1 keeps the shared secret. Unlike the derived indexes above such state cannot
  be rebuilt; what losing it costs is reference material — see #84 until it
  lands in the architecture doc.
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

**Three sources, three questions.** CLAUDE.md answers *what binds you* — rules,
constraints, and decided architecture stated as prohibition. It is loaded
unconditionally into every agent, so anything an agent must not violate belongs
here even if it never opens a doc; a rule you might not read is not a rule.
The documents answer *what is true* — the status quo, and decisions already
taken that are not yet code, where the doc says so explicitly. GitHub answers
*what is changing* — the work itself.

When a decision has both a mechanism and a plan to build it, they split: the
mechanism and its reasoning go in a doc, and the issues carry the work — what
to implement, runnable acceptance criteria, scope, sequencing. Shared context
is cited from issue Pointers by title and UUID, never restated into issue
bodies, because a design copied into an issue body ages the moment the issue
closes. Bugs, proposals and planned work are GitHub's, never a doc's.

**Agent workflow:** read the relevant docs → compare against the code → the gap
is the work → do the work via a GitHub-style change → update the doc to the new
status quo.

The live uberblick workspace is the only home of these documents. `list_docs`
is authoritative for what the corpus contains, and the MCP tools registered in
`.mcp.json` are how it is read and written. There is no repository snapshot of
it, no corpus import command, and no UUID table to keep in step — a document's
uuid is discovered from `list_docs`.

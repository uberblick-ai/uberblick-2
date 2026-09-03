# Deep architecture baseline

The baseline reconstructs and challenges the system that exists at the audited
`origin/main` SHA. It is not a file inventory, generic best-practices review, or
six independent grep searches. Its output must let a later auditor understand
what state exists, who owns it, how it crosses process and trust boundaries,
how it fails, and which evidence supports that account.

## Build the current architecture map

Derive the map from code and the live corpus rather than copying Architecture.
At minimum identify:

- packages and allowed dependency direction;
- processes and lifetimes: CLI children, MCP stdio server, web client, hub, and
  any external host or proxy;
- authoritative, replicated, cached, and derived state, including every SQLite
  store, browser persistence, Y.Doc room, configuration file, and in-memory
  queue that affects a promise;
- network, authentication, workspace, filesystem, process, and protocol trust
  boundaries; and
- public compatibility surfaces: schema shape, Yjs update encoding, room and
  workspace identity, MCP tools and failures, CLI behavior, sync protocol, and
  persisted storage.

Compare that derived map with Architecture
(`d2d28f20-7c9a-4547-b65b-0fdf75a41dff`) block by block where it makes a
material claim. A matching paragraph is not proof; name the implementation and
test that make it true. A code path with no corresponding architectural truth
is assessed in the other direction.

## Trace the load-bearing journeys

Trace each journey end to end across package and process boundaries. Name the
state before and after every boundary, the acknowledgement or commit point, the
error semantics, and recovery after interruption.

### Mutation and convergence

Follow both a local MCP mutation and a remote/web mutation through Yjs
transaction, update observer, append-only log, pending watermark, provider,
hub acknowledgement, debounced hub persistence, derived index, and a second
client. Check same-range conflict behavior, distinct-block convergence, update
origin, observer ordering, and whether `{applied, synced}` remains honest when
one boundary fails.

### Restart, offline, and hydration

Follow hub-down writes, MCP restart, hub restart inside and outside the store
debounce, reconnect, replay, directory-driven discovery, and a fresh empty
client. Identify what can be reconstructed, what is authoritative, what can be
temporarily missing, and which actor eventually repairs it. Exercise focused
failure paths where the repository already supplies a harness.

### Identity, configuration, and admission

Follow workspace identity and endpoint resolution from machine configuration
through `ub env`, spawned processes, token minting, protocol envelope, hub
authentication, room/workspace comparison, and rejection. Check where the root
secret is exposed, what the tailnet boundary actually protects, how inherited
configuration is neutralized, and how protocol mismatch differs from bad auth.

### Schema and editing round trip

Follow one document containing every supported block and mark through schema,
MCP read/write, web/Tiptap conversion, Yjs merge, Markdown export/import, and an
older or partially aware client where the contract depends on preservation.
Check stable block IDs, re-types, annotation anchors, link exclusivity,
decision ordering, archive behavior, and every documented loss boundary.

### Discovery and derived state

Follow document creation and metadata edits through the document, directory
stub, sidebar, FTS/tags/links index, backlinks, reconciliation, and tombstones.
Challenge partial multi-room writes, concurrent whole-entry updates,
rebuildability, duplicate repair, and whether an unreachable document can
become permanent.

### Process and deployment lifecycle

Follow CLI child creation, stdio ownership, signal forwarding, MCP stdout
purity, hub startup-before-listen, graceful shutdown, store failures, and the
remote proxy/container boundary. Distinguish a developer convenience from a
supported product guarantee.

## Challenge the design, not its style

Across those journeys assess:

- whether one fact has more than one authority or an authority has no durable
  owner;
- whether a cache, acknowledgement, clock, or local observation is mistaken
  for durable or global truth;
- whether concurrent processes, retries, reconnects, and partial writes preserve
  idempotence and recovery;
- whether package boundaries follow ownership or merely move imports around;
- whether compatibility and migration consequences are explicit at every
  persisted or wire surface;
- whether authentication happens before state admission and secrets cross only
  declared boundaries;
- whether error and shutdown paths preserve the same claims as happy paths; and
- whether large or duplicated modules concentrate unrelated authority enough to
  make a correctness change unsafe, rather than merely offending a size rule.

Do not invent an alternative architecture because it is fashionable. A finding
needs a reachable consequence inside the supported usage model and a smaller
defensible correction.

## Evidence floor

For every journey, record:

- governing corpus UUID plus material block id/rev;
- immutable code links at the audited SHA across every boundary traced;
- focused tests that defend the contract, including whether they use real
  processes, databases, sockets, or only mocks;
- at least one relevant failure-path probe, or a precise reason it could not be
  run; and
- conclusion and remaining uncertainty.

Also build a compact invariant-to-test map. Look for both missing proof and tests
that assert implementation trivia without defending an invariant. A passing
suite is supporting evidence, never the architecture conclusion by itself.

The baseline is `incomplete` when any load-bearing journey or technical lane has
no substantive evidence. State that directly; do not reduce the scope silently
or convert an omitted journey into a clean result.

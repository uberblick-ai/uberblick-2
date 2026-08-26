---
uuid: e6609049-7917-42ac-8ab3-f068aed2a707
title: Testing patterns
tags: [implementation-reference]
links: [f1f403e6-fb4b-4e95-b12f-4fc0df8f4957, 06777f59-3159-4511-8236-8fc66d70da27, 5238bd29-f9d5-43e8-ad40-2f039c705521, 7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8]
---

The idioms this codebase already has, and the bar a new test must clear. Read
this before adding one: most of what a new test needs already exists as a
helper, and most of what it might assert is already asserted somewhere with a
header saying where.

## Layout and runners

Vitest everywhere, one flat `test/` directory per package, no nesting. The web
package runs in jsdom and configures vitest inside its Vite config; every other
package runs in Node. Playwright specs live in `packages/web/e2e` and run only
on demand, Chromium only, one worker, no retries — a real-browser test that
only passes on the second attempt is not evidence of anything.

Shared rigs are `test/helpers.ts`, never a `.test.ts`, so the include glob
skips them. Fixtures sit in `test/fixtures` beside the script that made them.

## The mandatory file header

Every non-trivial test file opens with a comment block stating three things: the
one claim the file defends; why it is tested this way, naming what is real and
what is stubbed and what a cheaper version would miss; and what deliberately is
not here, with the exact path of the file that covers it instead. That last
part is the no-duplication ledger, and it is enforced by these headers rather
than by tooling.

## Reality over mocks

Real hubs on ephemeral ports, real websockets, real SQLite files, real spawned
binaries, real signals, real git repositories, real stub programs on the path.
Mocking appears only where the header justifies it — vendor command-line tools,
`fetch`, and the web app's room acquisition. The recurring formulation is that
mocking either side would test nothing.

## Assert on the far side

Web and MCP suites assert against a peer replica or against the hub's SQLite
file, never against the state the code under test just produced. A rendering
that agrees with the DOM but not with the document is a second corpus, and that
is the defect worth catching.

## The helpers that already exist

- Two-replica sync: `syncDocs` and `replicaPair` in the schema package compute both diffs before applying either, so neither side ever sees a half-synced peer.
- Fault injection: a store subclass whose append throws on demand, driving the real path rather than around it.
- Hub harnesses: a hub on port zero with a temp database and a silent logger, a real provider client exposing both a synced and a denied promise, a token minter, a room-name builder, and a teardown that closes clients before hubs because a live provider reconnects on close.
- MCP harnesses: a server and client over a linked in-memory transport, a config whose default hub URL is a dead port so a test that says nothing about the hub is testing the offline path, and a launcher that runs the server as a direct child so a kill signal reaches the process under test rather than a launcher.
- CLI rig: a throwaway XDG home that looks like a checkout, with every resolved variable scrubbed from the inherited environment first — otherwise a developer's exported secret turns a "no configuration" assertion into a test of their machine.
- Web rig: an editor mounted inside the real document body, sequential block ids, and a fragment snapshot that includes the delta so marks are part of every comparison.

## Timing

Production windows are the contract. Debounces and coarseness windows are set
to their real values and crossed by moving a faked clock, not shrunk to
something untrue. Where a short value is used it carries a comment saying what
it buys. Boundaries are asserted as literals rather than by importing the
constant, so changing the constant fails the test.

## The acceptance gate

One web test builds a document entirely through the schema, loads it into a
real editor bound through the sync plugin, dispatches a real keystroke, and
requires the fragment to come back recognisably the same: same elements, same
order, every id and attribute untouched, every mark still under its bare Yjs
key. That test is what stands between the editor and silent CRDT damage.

## What deserves a test here

Contracts and invariants: concurrency semantics, durability, the shapes other
packages depend on, the failure modes a user will actually hit. Not
implementation details, not trivia, not a second copy of an assertion another
package already owns. Each new test should be able to name the behaviour it
defends in one sentence — and if a header elsewhere already names it, the test
belongs there or nowhere.

## Beyond the unit suites

- `mise run e2e` — only what jsdom structurally cannot answer: real co-editing, real cursor decorations, a real IndexedDB replica surviving a reload, a real native drag seen by a second browser, real portal and focus behaviour, and a real fetch of the served config document.
- `mise run fue` — the documented install path, run on a machine that has only git and mise, then asserted with the network switched off.
- `mise run review` — lint, typecheck and test over an immutable commit, in a container with no network.
- Two meta-tests worth knowing: one scans sibling test sources to forbid a blocking spawn in any suite that serves in-process, and one executes the inline appearance-bootstrap script out of the HTML file as text.

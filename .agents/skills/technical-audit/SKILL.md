---
name: technical-audit
description: >-
  Run Uberblick's periodic read-only technical and corpus-to-code alignment
  audit. Use for a weekly baseline or incremental project health review across
  architecture, security, persistence, synchronization, MCP, CLI, web, tests,
  dependencies, and whether the live product corpus matches current code. Do
  not use as PR review, implementation, issue preparation, or a delivery gate.
---

# Technical audit

Find a few consequential, evidence-backed risks without turning broad static
analysis into hypothetical work. Write no code, corpus document, issue, label,
branch, or PR. The only permitted external write is one report to [Technical
audit reports](https://github.com/uberblick-ai/uberblick-2/discussions/541).

## Assignment and mode

Use the launcher's run identity verbatim. If none was supplied, create one as
`technical-audit-<UTC timestamp>-<short random suffix>` before any external side
effect and keep it unchanged. A valid prior report is a top-level reply in
Discussion #541 that begins `Technical audit`, carries `Run: technical-audit`,
and has a parseable `Cursor` block. Read the newest valid report:

- with no prior cursor, run `baseline` against current `origin/main`;
- otherwise run `incremental` from the recorded code SHA through current
  `origin/main`, plus the report's next rotating lane;
- if a valid report is less than seven days old, return `Audit not due` with its
  URL and stop without posting.

A baseline with a later owner reply containing exactly `Baseline: rejected` is
not valid for cadence or cursor purposes. The next run is a fresh baseline, not
an incremental continuation.

Use the prior report only as a cursor and hypothesis source. Reproduce open
findings against current code rather than carrying them forward by assertion.
Where evidence is comparable, summarize whether its material findings and
actions improved, stayed unchanged, or regressed. Use `incomparable` rather
than treating absence from the current sample as improvement.

## Establish the evidence boundary

Fetch `origin/main`, record its exact SHA, and inspect from that immutable tree.
Read `AGENTS.md`, `CLAUDE.md`, workspace manifests, TypeScript and Biome config,
the documented `mise` tasks, and the live package layout. Derive package counts,
line counts, dependency versions, and commands rather than hard-coding them.

In `baseline` mode, read
[`references/architecture-baseline.md`](references/architecture-baseline.md) in
full and follow it. A baseline is a deep architectural review, not one shallow
check per lane. Incremental mode does not load that reference unless changed
code invalidates the previous architecture map.

Use live Uberblick MCP tools to list and read product documents relevant to the
changed code and rotating lane. Every run reads Editorial contract
(`5e0e25d8-c71f-44c3-9bf3-93662712c1fc`), Information types and sources of
truth (`04e2b0aa-8dd5-4356-842e-554c1affe24f`), and Architecture
(`d2d28f20-7c9a-4547-b65b-0fdf75a41dff`) plus current documents governing the
sampled surface. Resolve titles, tags, and approximate `updatedAt` values from
`list_docs`; UUID, never title, is identity.

If MCP cannot provide required context, report the exact attempted operation
and mark corpus alignment `incomplete`. Technical checks may continue, but do
not make product-semantic conclusions from copied issue text or memory.

## Corpus-to-code alignment

Treat alignment as a first-class technical result. Sample both directions:

1. For changed or lane-critical code, identify the product promise, invariant,
   interface, or availability claim that governs it and verify implementation.
2. For each governing corpus claim sampled, identify its current implementation
   and observable proof, or establish that it is explicitly future or unresolved.
3. Check the truth lives in the correct source: corpus for current or settled
   near-term product truth, GitHub for changing work, `CLAUDE.md` for binding
   architecture and invariants, decision documents for choices and triggers.

Classify each material check:

- `aligned` — current statement and implementation agree;
- `corpus-ahead` — current or settled near-term truth lacks the concise
  availability boundary needed to keep not-yet-delivered behavior safe, or that
  boundary wrongly claims delivery; an explicit requirement or decision
  lifecycle is not drift;
- `code-ahead` — shipped behavior or guarantee is absent from current product truth;
- `contradiction` — sources or code make incompatible claims;
- `wrong-home` — truth is duplicated or maintained in the wrong authority; or
- `unverifiable` — the link cannot be established with available evidence.

Do not demand one-to-one documentation for internal mechanics. Report only a
gap that could mislead a user or agent, hide an invariant, cause a wrong product
choice, or make recovery materially harder.

For `corpus-ahead` or `code-ahead`, identify the merge or PR that introduced the
gap when history makes it derivable. The audit measures whether the owning
change completed `CLAUDE.md`'s merge-then-docs obligation; it does not become a
later documentation safety net. If attribution cannot be established, say so.
Before proposing corpus text, name which information source owns the claim.
Product documents should not duplicate volatile repository procedure merely to
make a technical finding easy to close.

## Technical lanes

A baseline follows the architecture reference and must leave evidence in every
lane below. Each incremental run examines the changed surface in every
applicable lane plus one rotating deep lane, storing the next lane in its
cursor. Rotation never postpones review of a trust, durability, or schema
boundary changed during the current code window.

1. **Corpus and public contracts** — interfaces, promises, availability
   boundaries, stale or duplicated authority.
2. **Schema and CRDT semantics** — closed Y.Doc shape, block IDs, marks,
   transaction boundaries, v1 updates, merge/convergence, delete/reorder,
   single Yjs instance.
3. **Durability and synchronization** — synchronous local update logging,
   truthful `{applied, synced}`, hub acknowledgement, restart, reconnect,
   hydration, offline edits, derived-index rebuildability, failure paths.
4. **Trust boundaries** — auth before admission, workspace isolation, secret
   handling, MCP stdout JSON-RPC purity and stderr logging, input/path/shell
   boundaries, temporary files, interrupts, and child processes.
5. **Web and editor behavior** — preservation of schema-owned shapes and marks,
   conflict handling, offline state, accessibility, and browser contracts.
6. **Maintainability and supply chain** — cross-package boundaries, oversized
   or duplicated logic, error handling, dependency advisories, brittle or
   implementation-trivia tests, and gaps in invariant coverage.

Use `CLAUDE.md` as the binding invariant index, not proof that code conforms.
Prefer focused code tracing and failure-path probes over broad tool output.
Existing lint, typecheck, and test failures are evidence but are not findings
without a reachable consequence. Never recommend tests solely from a coverage
percentage or file ratio.

Read-only probes use only documented `mise` tasks. If no task exposes a needed
dependency advisory check, record it as not run rather than invoking a package
manager directly. Never use an audit `--fix`, mutate lockfiles, install
dependencies, enable nursery lint rules, or add coverage tooling during an
audit. Run expensive full suites only when they materially test a suspected
finding; record unrun checks rather than implying they passed.

Material technical claims cite immutable evidence at the audited SHA: code and
line, the focused test or probe and result, and corpus UUID plus block id and rev
where product truth matters. A negative search states its exact scope and
pattern. A baseline with no substantive evidence for any lane is `incomplete`,
even when it also found defects.

## Findings and challenge

For each suspected finding, establish exact evidence, reachability inside the
supported usage model, concrete consequence, confidence (`proven`, `strong`, or
`hypothesis`), and the smallest correction with its appropriate owner. Use the
`P1`, `P2`, and `P3` definitions in
`.claude/skills/next-issue/review-protocol.md`. A hypothesis belongs in `Watch`,
not `Findings`. Record important suspicions rejected and recommend at most three
actions. Do not create an issue or repair code or corpus.

Before reporting, search Discussion #541 and the responsible PR or linked issue
for a prior explicit disposition. Do not repeat a fixed, deferred, documented,
or evidence-backed rejected finding unless new evidence overturns it; state
that delta. For corpus drift, include the attributable merge or say why it
could not be identified. Candidate actions name an explicit next owner and
route; never defer stale truth to “the next change touching it.”

## Report

Post one top-level reply. A baseline is normally under 12,000 characters and an
incremental report under 6,000; use compact evidence tables rather than omitting
architectural reasoning to meet a length target.

```text
Technical audit — YYYY-MM-DD
Run: technical-audit <run id>
Mode: baseline|incremental
Code: <previous SHA or none>..<origin/main SHA>
Corpus: <title (uuid), approximate updatedAt, exact block rev when material>
Verdict: aligned|findings|needs-owner|incomplete
Coverage: complete|incomplete
Change since previous audit: first-report|improved|unchanged|regressed|incomparable — <evidence>

Architecture assessment
- <load-bearing journey, state/authority transitions, boundaries, evidence, result>

Lane coverage
- <lane 1-6: scope; immutable code/test/corpus evidence; result; limits>

Corpus ↔ code
- <status> — <claim, implementation evidence, attributable merge, consequence>

Findings
- <P1|P2|P3> <confidence> — <finding, evidence, consequence, correction, owner>
  | None.

Watch
- <hypothesis and evidence needed to resolve it> | None.

Probes and checks
- <focused inspection or documented task and result, including checks not run>

Rejected suspicions
- <concern and counterevidence> | None.

Candidate actions
- <at most three, ordered by risk reduction per unit of change> | None.

Cursor
- Code: <origin/main SHA>
- Corpus: <title (uuid), approximate updatedAt; exact block revs where used>
- Next lane: <1-6 and name>
- Observed through: <UTC timestamp>

Audit self-assessment
- <coverage limits and the one context or tool improvement that would make the
  next audit cheaper or clearer, if applicable>
```

Link durable evidence instead of pasting long logs. A clean audit reports the
sample and its limits without manufacturing findings. `Coverage: incomplete`
requires `Verdict: incomplete`; findings may still be listed. Post no other
comment and stop.

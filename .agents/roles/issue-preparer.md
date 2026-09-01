# Issue preparer

Turns settled product intent into one ready issue an implementer can execute
without asking a product question, or a coordination parent with bite-sized
children.

Read `.agents/roles/README.md` before side effects. Role context: Uberblick
project agent workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`) and Editorial
contract (`5e0e25d8-c71f-44c3-9bf3-93662712c1fc`).

## Assignment

The preparer queue, plus your role and session or run identity. Refuse before
any side effect when either is missing; nothing else is supplied.

## Pickup

First, triage the unlabelled open issues by skimming title and body only: one
that asks for a concrete change — and is not a coordination parent, not
explicitly non-dispatchable, and not self-described as awaiting an owner
decision — clearly lacks its label; add `needs-preparation` and nothing else
(owner decision, 2026-08-31). Leave an ambiguous draft untouched for the
owner. The skim is not intake and posts no comment; adding the label is
idempotent under a concurrent run.

Eligible: an open issue carrying `needs-preparation` and none of `ready`,
`in-progress` or `needs-decision`, with no live top-level claim. A completed
preparer `Done:` whose named label transition is missing is eligible only for
that mechanical recovery, not another challenge. Order by issue number;
Priority belongs to implementation scheduling and is irrelevant here. Scan
only the labels, state and claims needed to establish eligibility and order,
then claim under the README's record and race rule **before** reading the full
body, thread, dependency graph, corpus or code. A losing claimer moves to the
next candidate before doing that deeper intake. Prepare one. An unlabelled
issue enters the queue only through that triage, never as an implicit pickup.
With nothing eligible, end with exactly
`No eligible issue-preparer work: <one reason>.` and stop; the launcher reads
that line to idle.

## Outcome

Own one pass from intake to `ready`, `split`, `wontfix`, or a serious owner
boundary.
Ground at fresh `origin/main`, align the body with the corpus and
`.github/ISSUE_SPEC.md`, and apply the grounded `wontfix` check below before
classifying only the route `.claude/skills/next-issue/preflight.md` defines.

Before drafting, compare the likely files with open PRs and record any real
dependency or semantic overlap. Keep grounding proportional: when code and
GitHub fully establish a mechanical issue and no product-sensitive choice is
being made, a concise reason for skipping corpus lookup is sufficient. Never
make repeated MCP calls merely to prove that no product document applies.

When this grounding establishes only a low-impact theoretical finding and no
current supported-usage failure, record why a delivery cycle is
disproportionate, finish `wontfix` without an adversary, remove preparation and
delivery labels, add `wontfix`, and close as not planned. Never use this for
data loss, auth/security exposure, or a violated invariant. A concrete bug
observed later may be filed or reopened as new evidence.

Use an adversary only when independent challenge could materially change the
contract. A grounded issue that names a narrow existing invariant, leaves no
product decision open, and has direct focused verification takes a
code-grounded self-check regardless of package path. Otherwise spawn exactly
one fresh `issue-adversary` subagent on this issue, giving it its own run
identity and this parent run. Prefer the other runtime/model when available —
Claude calls Codex and Codex calls Claude — dispatching it as
`.claude/skills/next-issue/preflight.md` states, and stay in your assignment
until its durable handoff exists. If that dispatch produces no verdict, record
it on the issue rather than substituting a same-runtime adversary silently.

Apply every meaning-preserving, correctable finding yourself, then repeat the
affected grounding and final recheck without launching a second adversary. If
the corrected issue is complete, safe, and within recorded owner-approved
product or program authority, post the `Done:` handoff and add `ready`. If an
unresolved finding crosses product, authority, safety, or fundamentally unsafe
shape, post concrete options and a recommendation, add `needs-decision`, and
leave `ready` absent. A second adversary happens only on explicit owner request.

When the request does not fit one independently reviewable PR, finish with
`split`. Technical decomposition is yours; decomposition that chooses product
behavior goes to `needs-decision`. Remove `needs-preparation` from the source,
leave it as a non-`ready` coordination parent, and create bite-sized children
with `needs-preparation`, `Parent: #N`, and only real ordering dependencies.

When picking up an issue after its first top-level implementer return, start a
fresh assignment but reuse the prior handoff, adversary verdict and return
evidence.
Refresh only the disputed contract, affected grounding and intervening upstream
changes; do not repeat classification, broad grounding or an adversary by
default. The same bounded continuation applies after `needs-decision`: include
the focused question and owner answer, which resets the consecutive-return
count. A second return without an intervening owner answer is already
`needs-decision`, not another automatic preparation pass.

## Boundaries

No implementation, branch, PR, or implementation scheduling. You may edit the
issue, disposition the one adversary's findings, set its final preparation
label, or close only through the `wontfix` route above; that is one assignment,
not self-review of code. Never invent product
meaning or silently waive a serious finding. Never set Priority: every explicit
value belongs to the product owner.

## Context

GitHub carries the issue and its history. Read the corpus for the product intent
this issue depends on. `.github/ISSUE_SPEC.md` governs the issue's shape and
`CLAUDE.md` the rules it must not violate.

## Handoff

Post before changing labels:

```text
Done: issue-preparer <run id>
Grounding: <origin/main SHA>
Preparation: trivial-self-check|one-adversary|resumed|grounded-wontfix
Outcome: ready|needs-decision|split|wontfix
```

Link the adversary handoff where one ran; summarize edits, dispositions and
evidence only where material to recovery. Keep it short and easy for a human to
scan: do not restate the final body, narrate the run, list generic gates, or put
the self-assessment on the issue. Do not back up the original intake after
rewriting it; retain its material intent in the final contract and record only
material decisions or corrections. Then apply the named label transition. A recovery
run that finds this handoff only finishes a missing transition and stops.

After that durable transition, post one separate run self-assessment as a
top-level reply to the `Agent Feedback` discussion
(https://github.com/uberblick-ai/uberblick-2/discussions/506), following its
prompt. Feedback is non-blocking telemetry; then stop.

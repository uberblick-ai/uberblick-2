# Issue preparation — ground, classify, challenge, recheck

This provider-neutral procedure owns grounding, challenge, and recheck after a
GitHub intake enters the preparation queue. `.agents/protocols/issue-shaping.md`
owns the earlier conversation; `.github/ISSUE_SPEC.md` owns the final body and
lifecycle; `.agents/roles/issue-preparer.md` owns the run and its outcome.

The preparer owns one grounded pass, applying correctable findings before its
final recheck. Independent challenge protects the contract before implementation;
it does not replace implementation correctness review.

## Ground it at a commit

Scan the corpus catalog with `list_docs` and use descriptions,
issue context and targeted search to select relevant product, architecture,
principle and decision documents. Read those documents, following links where
they govern the outcome; a catalog scan is not a read of every document body.
In the existing Pointers section, link each document the implementer needs by
title and UUID, with a short reason or relevant section. Preserve governing
constraints through those citations rather than copying the documents into the
issue. Mark a missing source as a gap; do not invent its intended content.
For a resumed pass, refresh only the affected discovery and links.

Fetch `origin/main` and record the exact SHA you ground
against — every later statement in the preflight is a claim about that commit,
not about your memory of the repo. Against it, read what the issue targets: the
current behavior, the modules, interfaces, invariants and tests it lives in,
related open issues and PRs, and the files the change is likely to touch. Read
the intended outcome of the effort this issue belongs to, and the human
decisions already recorded for it, from the records that exist: the parent
issue and its thread, the milestone, an `Implements:` requirement document, and
the Pointers citations — draft inside those decisions instead of
reopening them. Where none of those records exists that read is a no-op; an
ordinary issue needs no parent, planning map or overview. Verify each
load-bearing noun and promised outcome has a current substrate: shipped concepts
exist in current code, and settled targets exist in the current corpus.
Closed issue history is evidence only when a pointer or a missing substrate
makes it relevant; do not sweep `NOT_PLANNED` work as a separate gate.

When the issue is an investigation, its contract names the decision that
investigation informs, the uncertain assumption, and an observation that could
support or overturn it — the frame `.agents/protocols/issue-shaping.md` states
under "Keep the effort oriented", sized by `.github/ISSUE_SPEC.md`'s Sizing
rule. A bounded negative result resolves it, so neither the eventual feature
working nor the design that would follow it is a deliverable. This binds
investigations only; every other issue states its outcomes as usual.

Before drafting on **every** route, self-check included, list the files changed by
every open PR and compare them with the likely footprint. A file-list hit is the
start of the check: inspect the relevant PR diff before deciding whether the
overlap is a dependency, semantic conflict or mechanical reconciliation. Record real
overlap while it is still cheap to reshape or defer the issue. Prefer tracked
file searches (`git ls-files`, `rg`) and exclude `.claude/worktrees/` and
`.worktrees/`; copied agent worktrees are not additional grounding evidence. The
same question runs one step wider before `ready`: where this outcome affects
related planned work, record the affected contract or dependency in the prepared
issue itself — its Pointers, or a blocked-by relationship for a real
prerequisite (`gh issue edit <N> --add-blocked-by <M>`). The other issue is not
edited.

Grounding is proportional, not exhaustive — enough to establish the outcome,
approach and material risks. A proven mechanical, local correction may stop after the catalog scan
when no product document governs the change; say why in the handoff. Repeating MCP
calls to prove an absence is not grounding. If the base advances while you are
here, refresh only the grounding and challenge the new commits actually affect;
a merge elsewhere in the tree does not invalidate a challenge about this one.

When that fetch advances the base, inspect the changed paths. If the new commits
touch this role contract or the procedure files this run is executing, re-read
those files before continuing; refreshing the issue's code while following
stale workflow rules is not a valid recheck.

## Classify the route

First check for an implementer `returned` outcome, or a review verdict, after
the latest preparer handoff. On a review verdict, or the first consecutive
return since a human answer, use route `resumed`: read the prior preparation and
review evidence, refresh the reported conflict and affected upstream grounding,
and correct only that part of the issue. Do not reclassify, repeat broad
grounding, or require another review. A second consecutive return is already
parked on `needs-human`; after a person answers, resume the same way and treat
that answer as resetting the count. A return that exposes a new owner boundary
is an escalation rather than a way back to `ready`.

Classify from current evidence, not paths, labels or keywords. Self-check only
when the change is mechanical (no behavior or contract choice), understood,
local and easily reversed. Every other new preparation gets one independent
review. A spike has no automatic exemption.

| Route | Grounded condition | Reviews |
|---|---|---|
| `trivial` | mechanical, low uncertainty, local blast radius, easy reversal | none |
| `challenged` | any other combination | `agent` |

State the concrete route reason briefly in the handoff; the signals are not an
additional report.

## Challenge

For `trivial`, verify the grounded contract directly without a review and
finish `ready`. For `challenged`, finish `review`: `.agents/roles/reviewer.md`
runs on another runtime before `ready` lands. The
reviewer reconstructs from GitHub and tests the assumptions that could change the outcome, violate an invariant or waste
substantial work: missing failure boundaries, simpler approaches, real conflicts
with current work, and a coherent, independently useful work shape. Apply
ISSUE_SPEC's intent and sizing rules. Both preparer and reviewer distinguish
missing outcomes or invariants from optional engineering approaches; correct the
former without making the latter requirements or enumerating every edge case.
They also separate an empirical uncertainty from a human choice and from
ordinary engineering judgment, as `.agents/protocols/issue-shaping.md` defines
those three: answer the first from repository and corpus evidence, send only the
second to a human, and leave the third to implementation.

The reviewer classifies each material finding as `correctable` when settled
intent or repository evidence is enough, or `owner-boundary` for product or
agent authority, safety, or a fundamentally unsafe work shape, and escalates an
owner-boundary finding itself. A clean review lets `ready` land. Otherwise the
issue comes back with correctable findings, and the resumed pass applies them,
repeats the affected grounding and final recheck, and finishes `ready`. An
issue gets one review pass: a finding the preparer cannot settle without
another review or a person's choice is escalated.

## Recheck, then decide

Last thing before finishing, fetch `origin/main` again. Refresh only grounding
affected by an upstream change, then re-read the issue, its thread and any
review verdict.

Read the thread as well as the body. Where a comment amends or contradicts the
body, fold it into the body and delete what it replaces, linking the comment
only where traceability matters. Check the final body against ISSUE_SPEC,
including distinct observable outcomes.
Keep What to the outcome, acceptance criteria to the guarantees, and Pointers to
useful source locations and non-obvious traps. Remove discovery narration and
repeated rationale; preserve constraints and failure boundaries that change what
must be built. Corpus pointers give title, UUID and a short reason to read the
live source, not excerpts or summaries of it. Record material work-in-flight
overlap and its consequence, not a snapshot of every changed file. Length follows
the contract's complexity; neither a word target nor an exhaustive inventory is
required.

| Final finding state | Outcome |
|---|---|
| `challenged`, before its review | `review` |
| none, or all correctable findings applied | `ready` |
| unresolved product, authority, safety or unsafe-shape boundary | `needs-human` |
| request split into a parent and its sub-issues | `split` |

`ready` is the preparer's final verdict, within recorded owner-approved
authority; there is no later approval ceremony.
An owner boundary is the only normal preparation stop. It carries concrete
options and a recommendation, not another automatic review.

## Record once

Give each durable record one job: the issue body carries the final contract,
the review verdict carries the challenge and its evidence, and the preparer
handoff links that verdict and states the disposition. When all findings were
applied, say so once; do not explain each finding again. Explain an individual
disposition only when it is not evident from the final body and linked verdict,
such as a rejected finding or an unresolved owner choice. Retain the required
handoff fields and route reason. A review verdict, a human answer or the first
implementer return resumes from durable work, refreshing only affected evidence.

Preparer-authored prose names an issue by a descriptive title alongside its
`#N`: the prepared body's What, Why and Out of scope, a `needs-human`
question, and this handoff. Machine-read records and reference lists keep bare
identifiers and their own grammar — `Implements:`, `Outcome:` summaries,
`Closes`, and the Pointers list.

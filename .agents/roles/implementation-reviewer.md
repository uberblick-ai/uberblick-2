# Implementation reviewer

Examines one PR at one exact head for correctness, risk, missing evidence and
unnecessary complexity.

Shared rules: `.agents/roles/README.md`. Role context: Uberblick project agent
workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## Assignment

One of two complete shapes:

- a top-level assignment supplies the review queue, your role and your session
  or run identity, and nothing else;
- an implementer's or integrator's internal assignment supplies your role and
  run identity, one exact PR key and head SHA, and the parent role and run
  identity.

Refuse before any side effect when the selected shape is incomplete. For an
internal assignment, also refuse unless that PR carries the parent's live claim
or links the implementer's live issue claim for its branch, and carries the
README's matching durable delegation record at the supplied head.

## Pickup

For an internal assignment, never inspect or fall back to the queue. Re-read the
exact PR, prove its current head still matches the assignment and this session
did not author it, then post the permitted nested claim and review only that
head.

Prove session independence from durable evidence before claiming: compare the
head's `Claude-Session` trailers and its linked implementer claim/delegation
lineage with this run's launching session. Claude Agent children share their
launcher's authorship identity; a fresh child context or run id is not
independence. Refuse an internal assignment, or skip a top-level candidate, if
that session launched an implementer whose commit remains in the head.

For a top-level assignment, eligible: an open PR whose current head carries no
review record and no live reviewer claim at that head, **and whose diff this
session did not author** — check the commit trailers and the claim records on
the PR and its issue before claiming. Order: a `human-approved` PR still without
a review record first, then ascending PR number. Claim on the PR with the head
SHA, under the README's claim record and race rule. One review at one head, then
stop.

## Outcome

Reproducible findings against that head: what is wrong, where, why it matters,
and what evidence would settle it. Correctness and data safety first, then risk
and missing verification, then unnecessary complexity — a smaller change that
defends the same contract is a finding. No findings is itself a verdict and is
stated as one. Commits landing during the review do not silently move the
target: report the drift and stop; a review at the new head is a new pickup.

This is an adversarial implementation challenge, not a gate replay. Try to
falsify the change: trace important failure paths and boundary conditions,
challenge assumptions in the issue and PR record against the code and product
intent, and use focused probes or mutations where inspection alone cannot
settle the risk. Hunt explicitly for overengineering and overtesting. Gate
results may be evidence, but restating lint, tests or acceptance criteria is not
a review.

## Boundaries

No commits, no fix-ups, no merging, and no dispositioning. An implementer parent
may correct a finding or answer it with evidence before handoff; the integrator
still owns its authoritative disposition. **Never review a diff this session
authored.** A context reset does not create independence and no delegation
manufactures it.

## Context

GitHub carries the PR, its diff and its threads. Read the product documents the
issue's Pointers cite where a finding turns on product intent. `CLAUDE.md` owns
the invariants a finding is measured against.

## Handoff

The findings on the PR, at the exact head reviewed, with the reviewing session
recorded, in the form `.claude/skills/next-issue/review-protocol.md` records
rounds. Then stop.

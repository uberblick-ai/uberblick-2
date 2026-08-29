# Implementation reviewer

Examines one PR at one exact head for correctness, risk, missing evidence and
unnecessary complexity.

Shared rules: `.agents/roles/README.md`. Role context: Uberblick project agent
workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## Assignment

The review queue, plus your role and session or run identity. Refuse before any
side effect when either is missing; nothing else is supplied.

## Pickup

Eligible: an open PR whose current head carries no review record and no live
reviewer claim at that head, **and whose diff this session did not author** —
check the commit trailers and the claim records on the PR and its issue before
claiming. Order: a `human-approved` PR still without a review record first,
then ascending PR number. Claim on the PR with the head SHA, under the README's
claim record and race rule. One review at one head, then stop.

## Outcome

Reproducible findings against that head: what is wrong, where, why it matters,
and what evidence would settle it. Correctness and data safety first, then risk
and missing verification, then unnecessary complexity — a smaller change that
defends the same contract is a finding. No findings is itself a verdict and is
stated as one. Commits landing during the review do not silently move the
target: report the drift and stop; a review at the new head is a new pickup.

## Boundaries

No commits, no fix-ups, no merging, and no dispositioning — what happens to a
finding is the integrator's. **Never review a diff this session authored.** A
context reset does not create independence and no delegation manufactures it.

## Context

GitHub carries the PR, its diff and its threads. Read the product documents the
issue's Pointers cite where a finding turns on product intent. `CLAUDE.md` owns
the invariants a finding is measured against.

## Handoff

The findings on the PR, at the exact head reviewed, with the reviewing session
recorded, in the form `.claude/skills/next-issue/review-protocol.md` records
rounds. Then stop.

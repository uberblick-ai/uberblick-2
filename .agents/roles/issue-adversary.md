# Issue adversary

Challenges one prepared issue before code makes its assumptions expensive.

Shared rules: `.agents/roles/README.md`. Role context: Uberblick project agent
workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## Assignment

The adversary queue, plus your role and session or run identity. Refuse before
any side effect when either is missing; nothing else is supplied.

## Pickup

Eligible: an open issue that is not a parent — its body lists no child issues —
carrying `.github/ISSUE_SPEC.md`'s machine-readable header, none of `ready`,
`in-progress` or `needs-decision`, no live claim by any role, whose latest durable
transition in `preflight.md` admits the adversary. The smaller tiers are challenged
inside the preparer's own pass and never arrive here. Order: that spec's scheduling
order — dependency topology, then `Priority` as the README defines it, then
ascending number. Claim on the issue with the grounding SHA, under the README's
claim record and race rule. Challenge one issue, then stop.

## Outcome

A verdict proportional to the issue's risk, naming its findings and taking one
of the outcomes `preflight.md` defines. **You own that procedure end to end** —
grounding, classification, the challenge, the recheck, the outcome comment keyed
by claim identity plus base SHA, and the labels the outcome carries; no launcher
performs any part of it. That file owns the tier table, the challenge questions,
the two-verdict cap and the outcome table; follow it there rather than a copy.

## Boundaries

No implementation, no branch, no PR, and no claiming the issue for
implementation — a *dispatch* verdict clears the issue for the owner's `ready`,
and you set neither `ready` nor `in-progress`; the implementer's own pickup
follows that signature. Do not rewrite the issue into what you would have
written: findings return to coordination, and nothing is dispatched to close a
gap by guessing. You never answer a product question on the owner's behalf.

## Context

GitHub carries the issue, its thread and the current claims. Read the product
documents its Pointers cite where the challenge turns on product intent.
`.github/ISSUE_SPEC.md`, `AGENTS.md` and `preflight.md` govern.

## Handoff

The verdict as a comment on the issue: the grounding commit, the tier and why,
the findings with their dispositions, and the outcome. Then stop — a resumed
adversary is no longer independent of what follows.

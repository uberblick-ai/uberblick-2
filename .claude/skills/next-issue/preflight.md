# Preflight — ground, classify, challenge, recheck

The `issue-preparer` owns this procedure end to end. A narrowly trivial issue
gets its code-grounded self-check; every other issue gets exactly one fresh
`issue-adversary` subagent inside the same preparer run. An objection here costs
a prompt; the same objection after implementation costs a review wave, fix-up
and re-gate.

## Ground it at a commit

`git fetch origin main` and record the exact `origin/main` SHA you ground
against — every later statement in the preflight is a claim about that commit,
not about your memory of the repo. Against it, read what the issue targets: the
current behavior, the modules, interfaces, invariants and tests it lives in,
related open issues and PRs, and the files the change is likely to touch.
Proportional, not exhaustive — enough to fill the table below honestly, and no
more. If `main` advances while you are here, refresh only the grounding and the
challenge the new commits actually affect; a merge elsewhere in the tree does
not invalidate a challenge about this one.

## Classify the route

Classify from the grounding, never a package name, label or keyword. A route is
`trivial` only when all four facts hold: the change is mechanical (no behavior
or contract choice), understood, local, and easy to undo. Every other
combination is `challenged` and gets one adversary.

| Route | Grounded condition | Adversaries |
|---|---|---|
| `trivial` | mechanical, low uncertainty, local blast radius, easy reversal | 0 |
| `challenged` | any other combination | 1 |

`preflight-tier.mjs` beside this file is the executable form and its focused
test holds the two together. `Touches` remains outside the signal set: a proven
mechanical correction can be trivial in a sensitive package, while an
innocuous-looking issue whose outcome is unclear is challenged anywhere.

## Challenge

For `trivial`, the preparer performs a brief code-grounded self-check and spawns
no adversary. For `challenged`, it spawns exactly one fresh issue-adversary on
the issue, scoped to this parent run. Prefer a different runtime/model where
available. The adversary reconstructs from GitHub, pokes holes, writes its
durable handoff, and does not edit the issue or implement. Ask for:

- Is this the real problem, and is the issue's outcome the smallest viable one?
  What would KISS/YAGNI cut?
- Does it split usefully into smaller issues?
- Is anything over-prescribed — mechanics stated where an outcome would do?
- Does it conflict with current behavior, the decided architecture, existing
  tests, migrations, contracts, security or concurrency semantics, or work
  already in flight?
- Which edge cases and simpler alternatives does the issue not mention?

The adversary classifies each material finding as `correctable-findings` when
settled intent or repository evidence is enough, or `owner-boundary` for product
or agent authority, safety, or a fundamentally unsafe work shape. The preparer
applies correctable findings in this same run and repeats the affected grounding
and final recheck. It does not call a second adversary to review those edits.
Another adversary is exceptional and requires an explicit owner request.

## Recheck, then decide

Last thing before posting the outcome, `git fetch origin main` again. Refresh
only grounding affected by an upstream change, then re-read the issue, parent
claim, nested adversary handoff and labels.

| Parent still owns the issue | Final finding state | Outcome | Labels | Comment |
|---|---|---|---|---|
| yes | none (`none`) | ready | add `ready` | yes |
| yes | all correctable findings applied (`correctable-applied`) | ready | add `ready` | yes |
| yes | unresolved product, authority, safety or unsafe-shape boundary (`owner-boundary`) | park-needs-decision | remove `ready`, add `needs-decision` | yes |
| no | anything (`any`) | requeue | none | no |

The recheck outranks findings: if the parent no longer owns the issue, do not
change labels or comment. Otherwise `ready` is the preparer's final verdict,
within recorded owner-approved authority; there is no later approval ceremony.
An owner boundary is the only normal preparation stop. It carries concrete
options and a recommendation, not another automatic adversary round.

## Record it once, and only after the recheck

The nested adversary writes its `Done:` handoff before the preparer acts. After
the recheck, the preparer writes one concise `Done:` handoff with grounding,
route, adversary link where applicable, material findings and dispositions, and
`Outcome: ready|needs-decision`. Never include transcripts, timings or round
narration. A requeue writes none.

The preparer posts `Done:` before applying the named label transition. A retry
of the same run edits only its own record. If the durable handoff exists but the
label write did not complete, a later preparer finishes that transition without
rerunning the challenge. GitHub therefore recovers the pass without a lifecycle
comment graph or a second adversary.

**Findings are not requirements.** Material implementation risks and options
travel to the implementer in the brief, as options. They are never edited into
the issue body's acceptance criteria: an alternative written into the contract
becomes a requirement nobody chose, and out-of-scope prescription is exactly
what the challenge exists to remove. An issue that over-prescribes mechanics is
the same case and not a stop: name the freedom in the body and proceed. A
correctable missing outcome or invariant is fixed in this pass; only an
unresolved owner boundary stops it.

**A preflight is re-entrant.** Reuse a completed adversary handoff for the same
parent pass. A crash before one exists restarts the one-pass preparation; a
crash after it does not buy another verdict. The preparer remains responsible
for applying its findings and writing the sole final preparation outcome.

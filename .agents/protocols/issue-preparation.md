# Issue preparation — ground, classify, challenge, recheck

This provider-neutral procedure owns grounding, challenge, and recheck after a
GitHub intake enters the preparation queue. `.agents/protocols/issue-shaping.md`
owns the earlier conversation; `.github/ISSUE_SPEC.md` owns the final body and
lifecycle; `.agents/roles/issue-preparer.md` owns queue authority and side
effects.

The preparer owns one grounded pass, applying correctable findings before its
final recheck. Independent challenge protects the contract before implementation;
it does not replace implementation correctness review.

## Ground it at a commit

After pickup, scan the corpus catalog with `list_docs` and use descriptions,
issue context and targeted search to select relevant product, architecture,
principle and decision documents. Read those documents, following links where
they govern the outcome; a catalog scan is not a read of every document body.
In the existing Pointers section, link each document the implementer needs by
title and UUID, with a short reason or relevant section. Preserve governing
constraints through those citations rather than copying the documents into the
issue. Mark a missing source as a gap; do not invent its intended content.
For a resumed pass, refresh only the affected discovery and links.

`git fetch origin main` and record the exact `origin/main` SHA you ground
against — every later statement in the preflight is a claim about that commit,
not about your memory of the repo. Against it, read what the issue targets: the
current behavior, the modules, interfaces, invariants and tests it lives in,
related open issues and PRs, and the files the change is likely to touch. Read
the intended outcome of the effort this issue belongs to, and the owner
decisions already recorded for it, from the records that exist: the `Parent:`
header and its umbrella thread, the milestone, an `Implements:` requirement
document, and the Pointers citations — draft inside those decisions instead of
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
issue itself — its Pointers, or `Depends-on` for a real prerequisite. The other
issue is not edited.

Grounding is proportional, not exhaustive — enough to establish the outcome,
approach and material risks. A proven mechanical, local correction may stop after the catalog scan
when no product document governs the change; say why in the handoff. Repeating MCP
calls to prove an absence is not grounding. If `main` advances while you are
here, refresh only the grounding and challenge the new commits actually affect;
a merge elsewhere in the tree does not invalidate a challenge about this one.

When that fetch advances `main`, inspect the changed paths. If the new commits
touch this role contract or the procedure files this run is executing, re-read
those files before continuing; refreshing the issue's code while following
stale workflow rules is not a valid recheck.

## Classify the route

First check for a valid top-level implementer `Returned:` record after the latest
preparer handoff. On the first consecutive return since an owner answer, use
route `resumed`: read the prior preparation and adversary evidence, refresh the
reported conflict and affected upstream grounding, and correct only that part
of the issue. Do not reclassify, repeat broad grounding, or launch another
adversary by default. A second consecutive return is already parked on
`needs-decision`; after the owner answers, resume the same way and treat that
answer as resetting the count. A return that exposes a new owner boundary goes
to `needs-decision` rather than back to `ready`.

Classify from current evidence, not paths, labels or keywords. Self-check only
when the change is mechanical (no behavior or contract choice), understood,
local and easily reversed. Every other new preparation gets one independent
adversary. A spike has no automatic exemption.

| Route | Grounded condition | Adversaries |
|---|---|---|
| `trivial` | mechanical, low uncertainty, local blast radius, easy reversal | 0 |
| `challenged` | any other combination | 1 |

`issue-preparation.mjs` expresses these grounded signals and the existing final
recheck in executable form. State the concrete route reason briefly in the
existing handoff; the signals are not an additional report.

## Challenge

For `trivial`, verify the grounded contract directly without an adversary.
For `challenged`, delegate one fresh issue-adversary scoped to this parent run,
preferably on the other runtime/model. It reconstructs from GitHub and tests the
assumptions that could change the outcome, violate an invariant or waste
substantial work: missing failure boundaries, simpler approaches, real conflicts
with current work, and a coherent, independently useful work shape. Apply
ISSUE_SPEC's intent and sizing rules. Both preparer and adversary distinguish
missing outcomes or invariants from optional engineering approaches; correct the
former without making the latter requirements or enumerating every edge case.
They also separate an empirical uncertainty from an owner choice and from
ordinary engineering judgment, as `.agents/protocols/issue-shaping.md` defines
those three: answer the first from repository and corpus evidence, send only the
second to the owner, and leave the third to implementation.

The adversary classifies each material finding as `correctable-findings` when
settled intent or repository evidence is enough, or `owner-boundary` for product
or agent authority, safety, or a fundamentally unsafe work shape. The preparer
applies correctable findings in this same run and repeats the affected grounding
and final recheck. It does not call a second adversary to review those edits.
Another adversary is exceptional and requires an explicit owner request.

Use `.agents/adapters/runtime-dispatch.md` for invocation. Keep the assignment
open and renew ownership until the child's durable record completes or the
transport fails. Record a failed dispatch by updating that delegation, not by
claiming a verdict exists; name the runtime that actually performed a challenge.
Inspect private logs only to diagnose missing results.

## Recheck, then decide

Last thing before posting the outcome, `git fetch origin main` again. Refresh
only grounding affected by an upstream change, then re-read the issue, parent
claim, nested adversary handoff and labels.

Check the final body against ISSUE_SPEC, including distinct observable outcomes.

| Parent still owns the issue | Final finding state | Outcome | Labels | Comment |
|---|---|---|---|---|
| yes | none (`none`) | ready | remove `needs-preparation`, add `ready` | yes |
| yes | all correctable findings applied (`correctable-applied`) | ready | remove `needs-preparation`, add `ready` | yes |
| yes | unresolved product, authority, safety or unsafe-shape boundary (`owner-boundary`) | park-needs-decision | remove `needs-preparation`, remove `ready`, add `needs-decision` | yes |
| yes | request was split into a coordination parent and child intakes (`split`) | split | add `umbrella`, remove `needs-preparation`, remove `ready` | yes |
| no | anything (`any`) | requeue | none | no |

The recheck outranks findings: if the parent no longer owns the issue, do not
change labels or comment. Otherwise `ready` is the preparer's final verdict,
within recorded owner-approved authority; there is no later approval ceremony.
An owner boundary is the only normal preparation stop. It carries concrete
options and a recommendation, not another automatic adversary round.

## Record once

Use the role's existing handoff and label sequence after the recheck. Link the
completed adversary record and report only material changes and dispositions;
do not repeat the final body or narrate the run. Follow the README's expiry
rules, reusing a completed adversary for the same pass. An owner answer or first
implementer return resumes from durable work, refreshing only affected evidence.

Preparer-authored prose names an issue by a descriptive title alongside its
`#N`: the prepared body's What, Why and Out of scope, a `needs-decision`
question, and this handoff. Machine-read records and reference lists keep bare
identifiers and their own grammar — `Depends-on`, `Parent:`, `Implements:`,
claim, delegation and `Done:` records, `Closes`, and the Pointers list.

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

`git fetch origin main` and record the exact `origin/main` SHA you ground
against — every later statement in the preflight is a claim about that commit,
not about your memory of the repo. Against it, read what the issue targets: the
current behavior, the modules, interfaces, invariants and tests it lives in,
related open issues and PRs, and the files the change is likely to touch. Verify
each load-bearing noun and promised outcome has a current substrate: shipped
concepts exist in current code, and settled targets exist in the current corpus.
Closed issue history is evidence only when a pointer or a missing substrate
makes it relevant; do not sweep `NOT_PLANNED` work as a separate gate.

Before drafting on **every** route, self-check included, list the files changed by
every open PR and compare them with the likely footprint. A file-list hit is the
start of the check: inspect the relevant PR diff before deciding whether the
overlap is a dependency, semantic conflict or mechanical reconciliation. Record real
overlap while it is still cheap to reshape or defer the issue. Prefer tracked
file searches (`git ls-files`, `rg`) and exclude `.claude/worktrees/` and
`.worktrees/`; copied agent worktrees are not additional grounding evidence.

Grounding is proportional, not exhaustive — enough to establish the outcome,
approach and material risks. A proven mechanical, local correction may skip broad
repository and issue corpus searches when the handoff says why. Repeating MCP
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

The adversary classifies each material finding as `correctable-findings` when
settled intent or repository evidence is enough, or `owner-boundary` for product
or agent authority, safety, or a fundamentally unsafe work shape. The preparer
applies correctable findings in this same run and repeats the affected grounding
and final recheck. It does not call a second adversary to review those edits.
Another adversary is exceptional and requires an explicit owner request.

**Dispatching the other runtime.** Follow "Requesting the round" in
`.claude/skills/next-issue/review-protocol.md` for the common transport mechanics.
From Codex, use its Claude command with `issue-adversary` in place of
`implementation-reviewer`. From Claude, start the Codex adversary directly — the
repository runner is authorized only for implementation review:

```sh
( codex exec -C <parent-worktree> -s workspace-write -c 'sandbox_workspace_write.network_access=true' - < <prompt-file> > <scratch-log> 2>&1; echo $? > <scratch-log>.status )
```

`codex exec` selects no
`.codex/agents/*.toml` adapter, so that prompt tells the child to read the
`issue-adversary` role contract and supplies the exact issue, child run id and
parent run id. Do not route this through the companion `codex-rescue`/task
helper: its read-only Git metadata cannot satisfy the role's grounding fetch.
Read the verdict from the issue's completed mutable delegation record, not the
terminal or log. The private scratch log prevents the child's reasoning
transcript from consuming the parent's context and is inspected only when the
command fails or no durable verdict appears.

**Hold the pass open until the verdict exists.** A round takes 15–20 minutes
and a foreground shell call is killed at ten, so a foreground dispatch
guarantees a dead child and a lost round (observed 2026-08-31: SIGTERM at
exactly 10:00, replacement delegation required). Dispatch `codex exec`
detached — a background command still writing the scratch log — then stay in
the assignment, watch the issue for the delegation record to become
`Status: complete`, and keep renewing your own claim meanwhile. A preparer that
ends its turn while that record is still `pending` or `running` leaves a live
claim and a promised verdict nobody is waiting on, which reads to every other
role exactly like work in progress.

**A dispatch that produces no verdict is recorded, never papered over.** If the
other runtime does not run, edit its delegation record to `Status: failed` with
one reason instead of adding a failure comment; if a same-runtime adversary
stands in, its record names the runtime that actually challenged. A degradation
nobody can see is worse than the round being skipped: the cross-runtime
preference exists because a different model reads the same body differently, and
a record claiming a round that never happened spends that credibility for
nothing.

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

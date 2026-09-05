# Issue preparation — ground, classify, challenge, recheck

This provider-neutral procedure owns grounding, challenge, and recheck after a
GitHub intake enters the preparation queue. `.agents/protocols/issue-shaping.md`
owns the earlier conversation; `.github/ISSUE_SPEC.md` owns the final body and
lifecycle; `.agents/roles/issue-preparer.md` owns queue authority and side
effects.

The `issue-preparer` owns this procedure end to end. A narrowly trivial issue
gets its code-grounded self-check; every other new preparation gets exactly one
fresh `issue-adversary` subagent inside the same preparer run. A resumed owner
decision or implementer return reuses that completed pass. An objection here
costs a prompt; the same objection after implementation costs a review wave,
fix-up and re-gate.

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

Before drafting on **every** route, trivial included, list the files changed by
every open PR and compare them with the likely footprint. A file-list hit is the
start of the check: inspect the relevant PR diff before deciding whether the
overlap is a dependency, semantic conflict or mechanical reconciliation. Record real
overlap while it is still cheap to reshape or defer the issue. Prefer tracked
file searches (`git ls-files`, `rg`) and exclude `.claude/worktrees/` and
`.worktrees/`; copied agent worktrees are not additional grounding evidence.

Grounding is proportional, not exhaustive — enough to fill the table below
honestly, and no more. A proven mechanical, local correction may skip broad
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

Classify from the grounding, never a package name, label or keyword. A route is
`trivial` only when all four facts hold: the change is mechanical (no behavior
or contract choice), understood, local, and easy to undo. Every other
combination is `challenged` and gets one adversary.

| Route | Grounded condition | Adversaries |
|---|---|---|
| `trivial` | mechanical, low uncertainty, local blast radius, easy reversal | 0 |
| `challenged` | any other combination | 1 |

`issue-preparation.mjs` beside this file is the executable form and its focused
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
- Would the expected diff be reviewable in one sitting, and would each proposed
  child have an independently useful outcome? Body length is not a split test.
- Is anything over-prescribed — mechanics stated where an outcome would do?
- Does the contract compress independently failing behaviors into compound
  acceptance checkboxes merely to stay under the five-item cap? If so, regroup
  only genuinely coupled conditions and split independently useful outcomes.
- Does an acceptance boundary normally belong to an established primitive or
  dependency, while avoiding that choice would require bespoke safety,
  accessibility or protocol machinery? Surface the intended shape and any
  owner decision before `ready`; merge tier routes approval and is not a reason
  to prescribe a more complex workaround.
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

The final body has one to five acceptance criteria. Every checkbox states one
observable outcome or invariant; closely coupled conditions may clarify it,
but independently failing behaviors do not get compressed into one sentence to
meet the cap. Use a split when more than five distinct outcomes remain. A
checkbox is never a test/e2e recipe, test filename, implementation step,
generic delivery gate or post-merge corpus task.

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

## Record it once, and only after the recheck

The nested adversary completes its mutable delegation record before the
preparer acts. After the recheck, the preparer writes one concise `Done:`
handoff with the grounded commit, route, adversary link where applicable, only
material findings and dispositions, and `Outcome:
ready|needs-decision|split`. Use `Preparation: resumed` for an
implementer-return or owner-answer continuation. Link the final body or
children instead of restating them. After the four required lines, use only the
material detail needed for recovery. Do not include transcripts, run narration,
generic delivery gates, or the self-assessment. A requeue writes none.

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

**Preparation is re-entrant.** Follow the README's nested-assignment expiry and
reuse a completed adversary handoff for the same parent pass. The preparer still
applies its findings and writes the sole final outcome.

**A decision resumes from durable work.** Follow ISSUE_SPEC's `needs-decision`
exit path: reuse its durable records, refresh only affected grounding, and do
not repeat classification or the adversary by default.

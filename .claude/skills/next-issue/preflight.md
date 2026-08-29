# Preflight — ground, classify, challenge, recheck

The `issue-adversary` role runs this procedure on the issue its `Pickup`
selected, and owns it end to end; for the trivial and bounded tiers the
`issue-preparer` runs it inside the pass that prepared the issue, and nothing at
those tiers reaches the adversary. This is the project's one cheap chance to be
wrong: an objection raised here costs a prompt, and the same objection after
implementation costs a review wave, a fix-up dispatch and a re-gate.

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

## Classify

**Classify from what the grounding found**, never from a package name, a label
or a keyword. Four axes, and only these four:

- **Materiality** — what the change decides. `mechanical`: no behavior or
  contract choice is being made (a localized typo, routine documentation or
  maintenance, an obvious isolated correction). `behavioral`: real observable
  behavior with established patterns in this repo. `architectural`: a public
  contract, schema, data shape or migration, security/privacy, or concurrency
  semantics.
- **Uncertainty** — `high` when the grounding read left you unable to state the
  outcome and the invariants it must hold.
- **Blast radius** — `wide` for cross-package or cross-repository contracts, or
  for broad or ambiguous scope.
- **Reversibility** — `hard` when the choice is expensive to undo once merged:
  persisted data, a published contract, a shape other work builds on.

| Materiality | Uncertainty | Blast radius | Reversibility | Tier | Challengers |
|---|---|---|---|---|---|
| mechanical | low | local | easy | trivial | 0 |
| mechanical | high | local | easy | bounded | 1 |
| behavioral | low | local | easy | bounded | 1 |
| behavioral | high | local | easy | substantial | 2 |
| behavioral | low | wide | easy | substantial | 2 |
| behavioral | low | local | hard | substantial | 2 |
| architectural | low | local | easy | substantial | 2 |

Read it as three rules. Substantial when the change is architectural, wide, or
hard to undo — *any* of the three, so a mechanical change with a wide blast
radius is substantial too, and deliberately so: a rename with two hundred call
sites decides nothing but breaks everything. Trivial only when it is
mechanical, local, easy to undo **and** understood. Everything else is bounded
— and `uncertainty: high` then moves the tier one step up, which is what routes
a genuinely ambiguous change to two challengers instead of one.
`preflight-tier.mjs` beside this file is this table in executable form and
`preflight-tier.test.mjs` beside them holds the two together; if you change one,
change both.

Two things the table deliberately cannot see: `Touches`, and any keyword. A
change proven mechanical by the grounding read is trivial even in `schema` — a
proven fact outranks a package name — and an innocuous-looking change nobody
can state the outcome of is not trivial anywhere.

## Challenge

Who runs the challengers follows the tier, and only the tier: the trivial
self-check and the bounded tier's single challenger belong to the
`issue-preparer`, run inside the pass that prepared the issue and dispositioned
in its body; a substantial issue's two are the adversary's. Nothing else about
the challenge changes with who runs it.

A challenger pokes holes; it does not implement, and it does not write code.
Each runs in a fresh context that neither authored the issue nor will implement
it. For two-challenger cases prefer diverse perspectives — a different model
family, harness or approach — and where none is available, two separate fresh
contexts satisfy independence; say which you got. The brief asks for risks,
questions and alternatives:

- Is this the real problem, and is the issue's outcome the smallest viable one?
  What would KISS/YAGNI cut?
- Does it split usefully into smaller issues?
- Is anything over-prescribed — mechanics stated where an outcome would do?
- Does it conflict with current behavior, the decided architecture, existing
  tests, migrations, contracts, security or concurrency semantics, or work
  already in flight?
- Which edge cases and simpler alternatives does the issue not mention?

For the trivial tier this is a brief code-grounded self-check instead, at the
same commit.

**Two verdicts, then the owner.** An issue carries at most two adversary
verdicts — the adversary `Done:` records posted on it since it was last labelled
`ready`, or ever where it never was. At two, preparation has stopped converging
on its own: the next preparer pass hands the issue to the owner, writing the
findings still open into Pointers as brief options, and `ready` becomes the
owner's read of the thread rather than a verdict's conclusion.

**Briefing a Codex challenger.** Its sandbox has no network, so stage what it
needs into a file first — the issue body, the thread, and the file excerpts the
challenge turns on — and brief it completely in that one prompt: the
`codex:codex-rescue` wrapper takes no follow-ups, so a question it asks back is a
round nobody can answer. Read the job from the directory it was started in with
`node <codex plugin>/scripts/codex-companion.mjs status|result <job-id>`. Bound
the wait at 15 minutes and record a challenger that did not return as one, rather
than waiting it out or writing the verdict it would have given.

## Recheck, then decide

Last thing before posting the outcome, `git fetch origin main` **again** — the
fetch you grounded against is minutes old, and only a fresh one can tell you
upstream moved while you were reading. An advance that
touches what you grounded sends you back to refresh the affected grounding and
challenge; an advance elsewhere in the tree does not. Then re-read the issue and
the current claims, and take the outcome off this table.

| Still eligible at the recheck | What preflight found | Outcome | Labels | Claim | Comment |
|---|---|---|---|---|---|
| yes | nothing blocking (`none`) | dispatch | none — the owner's `ready` follows the verdict; `in-progress` is the implementer's claim | yes | only when a challenger ran or the self-check found something |
| yes | a stale or incorrect contract (`stale-spec`) | return-to-coordination | remove `ready` | no | yes |
| yes | an owner-only product decision (`product-decision`) | park-needs-decision | remove `ready`, add `needs-decision` | no | yes |
| no | anything (`any`) | requeue | none | no | no |

The preflight never writes `in-progress` — the implementer's own claim does,
after the owner's `ready` — so no preflight path can leave that label on an
issue nobody is implementing. The other two labels are the preflight's: a stop
takes `ready` off — a no-op on an issue not yet granted it — and an owner
question adds `needs-decision`.

The recheck outranks every finding, which is the first row to read: if someone
else claimed the issue while you were grounding it, it is their work now.
Requeue silently — do not strip `ready`, do not comment. Findings you hold go to
the claim holder or wait for a fresh pickup; acting on live work from the
outside is worse than losing the finding.

Among the stops, which applies is the difference between evidence and authority.
A stale contract, a missing outcome or invariant, or a scope or splitting
decision the grounding read can settle goes back to coordination with the
evidence: `ready` comes off, the comment says what is wrong, and a corrected
body has to pass `.github/ISSUE_SPEC.md` and be granted `ready` before any later
pickup. Only an unresolved *product* question — one the repository cannot
answer — takes `needs-decision`, with concrete options and your recommendation
per the spec's exit path.

## Record it once, and only after the recheck

The comment is the preflight's one durable side effect, so it is written when
the outcome is known, never before: posted ahead of the recheck it can land on
an issue another agent claimed a minute ago, which is exactly what the requeue
row forbids. One concise issue comment for every one- and two-challenger case
and for either stop, carrying the base SHA, the tier and one line of rationale,
how many challengers ran and how they were independent, the material findings
with their dispositions (or "none"), and proceed or stop. Never transcripts,
never timings, never round-by-round narration — one comment, or the preflight
becomes the thing it was meant to prevent. A trivial self-check that found
nothing writes none, and a requeue writes none either.

**The comment is keyed by `<issue, base SHA>`.** Before posting, look for a
preflight comment on the issue already recording that same base SHA. If one is
there, this preflight ran before and died after posting it: edit that comment
instead of posting beside it. Exactly one preflight comment per issue per base
SHA, however often a preflight is re-run. A later pickup that grounds at a newer
commit is a different key and gets its own comment — not a duplicate, a second
preflight.

**Findings are not requirements.** Material implementation risks and options
travel to the implementer in the brief, as options. They are never edited into
the issue body's acceptance criteria: an alternative written into the contract
becomes a requirement nobody chose, and out-of-scope prescription is exactly
what the challenge exists to remove. An issue that over-prescribes mechanics is
the same case and not a stop: name the freedom in the brief and dispatch. Only a
*missing* outcome, invariant or product decision stops one.

**A preflight is re-entrant.** An invocation that dies partway through one is
repeated by the next pickup, and the repeat costs tokens and nothing else,
because both of its durable effects are guarded: the owner's `ready` comes after
this gate, so a second run either re-reaches dispatch or finds the issue no
longer eligible at its recheck and requeues; and the comment is keyed by base
SHA, so a second run at the same commit edits the first run's comment rather
than posting a second.

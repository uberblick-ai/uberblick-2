# Review protocol — findings, corrections and rounds

Read this whenever a PR has a review to give, a finding to handle or a
correction to verify. `delivery-policy.md`'s "Reviews owed" table decides which
reviews a change owes; ub-agents runs them at the head under review, and
`integration.md` beside this file owns the gates' mechanics.

Every review is critical: try to falsify the implementation with focused
failure-path or mutation probes, and hunt specifically for overtesting and
overengineering per this repo's principles (KISS/YAGNI, least code wins, tests
defend contracts and invariants rather than implementation trivia).

## Findings

A finding has a stable id (`R<round>-F<number>`) and names the affected code,
the supported-usage consequence, a proposed severity and the reproducible
evidence that would settle it. Separate observations from assumptions. Record a
successful probe only when it resolves a finding or establishes a material
limitation.

- **P1:** data loss, secret exposure, violated invariant, or materially unusable
  supported behavior.
- **P2:** another concrete defect in supported usage.
- **P3:** minor or theoretical impact.

A finding keeps its id across heads. Reopen a settled one only when changed
code or new evidence invalidates how it was settled.

A choice that passes
[`delivery-policy.md`'s when-to-record test](delivery-policy.md#decision-records)
without a record is a finding; the implementer writes the record
([`implementer.md`](../roles/implementer.md#decision-records)) and the
corrections review verifies it like any other correction.

## Handing findings over

Three records carry findings between implementer and reviewer, so no separate
ledger is kept:

1. The verdict lists every finding.
2. The implementer's revision summary lists every id once, as `corrected in
   <sha>` or `answered: <evidence>`.
3. The corrections review marks every listed id `resolved`, `explanation
   accepted` or `unresolved — <why>`.

Copilot remarks, when a person requested that review, carry no finding ids:
the same revision corrects or answers them in their own threads, and any still
open at integration are the integrator's to answer.

## Settling a finding

Correct P1s, contained supported-usage P2s and any branch-caused failure of a
required check. Correct a P3 only when local and inexpensive; it must not drive
a redesign or another round. Instead of correcting, the implementer may answer
with evidence: the finding is wrong; its impact is theoretical because no
current supported-usage failure is established; it lies outside the supported
usage model; or, for a non-blocking P2, it is deferred to a linked issue with
the accepted risk stated. Never defer or accept data loss, security exposure or
a violated invariant.

The author cannot settle a finding alone; the corrections review does. A P3
that is neither corrected nor answered is accepted debt. A concrete bug
observed later is new evidence and may be filed or reopened then.

## Rounds

A pull request gets at most two review rounds. The second is a corrections
review by the review that asked for changes. It is required when the first
round found a P1 or two or more P2s, or when the implementer answers a P1 or
P2 instead of correcting it. Otherwise the implementer asks for one only when a
correction carries risk of its own. It asks by finishing `review`, and
otherwise finishes `integrate`. P3s never require a round.

The second round approves when every listed P1 and P2 is resolved or its
explanation accepted, and the corrections introduced no new P1 or P2.
Otherwise it escalates, naming the mechanism that keeps the change from
converging; there is no third round.

The count starts again in two cases. A full review the integrator requests
with `review` is the first round of a new count; one that lists finding ids is
the missing second round itself. A person's answer to an escalation makes the
next corrections review a fresh second round; the implementer asks for it when
the answer asks for verification or the rule above still requires one.

An issue gets one review pass (`issue-preparation.md`).

## Completion

The integrator checks the record rather than the code again: every P1 and P2 id
has a correction or an accepted answer, and a second round ran where this
protocol requires one. A P3 left untouched is accepted debt. Merge requires
`delivery-policy.md`'s gates and no open P1 or P2.

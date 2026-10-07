# Review protocol — findings, corrections and rounds

Read this whenever a PR has a review to give, a finding to handle or a
correction to verify. `delivery-policy.md`'s "Reviews owed" table decides which
reviews a change owes; ub-agents runs them at the head under review, and
`integration.md` beside this file owns the gates' mechanics.

This is an adversarial implementation challenge, not a gate replay. Try to
falsify the change: trace important failure paths and boundary conditions,
challenge assumptions in the issue and PR record against the code and product
intent, and use focused probes or mutations where inspection alone cannot
settle the risk. Hunt explicitly for overengineering and overtesting. Gate
results may be evidence, but restating lint, tests or acceptance criteria is not
a review.
Follow KISS/YAGNI: tests defend contracts and invariants rather than implementation trivia.

## Reviewer assignment and task

Read [the reviewer entry](../roles/reviewer.md) and shared core first when
assigned a review. Given a pull request and its exact head, the latest handoff
sets the scope: finding ids to verify — from an implementer revision or an
integrator requesting a missing second round — mean a corrections review;
otherwise the review is full.

Reproducible findings against that head, in the [Findings](#findings)
format: what is wrong, where, why it matters, what evidence would settle it,
and a proposed P1/P2/P3 severity grounded in the concrete supported-usage
consequence. Correctness and data safety first, then risk and missing
verification, then unnecessary complexity — a smaller change that defends the
same contract is a finding. No findings is itself a verdict and is stated as one.

Check the PR's mechanism and evidence under
[library and custom-mechanism choices](delivery-policy.md#library-and-custom-mechanism-choices),
including live web UI criteria and owner-confirmed exceptions where required.

Product intent is read, not inferred from the issue text: read the corpus
documents the issue's Pointers cite, live through MCP, wherever the change
touches their product meaning, and follow their links where they govern the
outcome. If MCP cannot serve a document the judgment needs, finish
`defer`, naming the document and the failure, rather than judging intent
without it. The pull request's `Corpus update` is part of the change: a missing
rewrite for a claim the change makes wrong, or one that misstates the change,
is a finding.

A corrections review asks a narrower question: for each finding id the
revision lists, does the corrected head resolve it, or is the implementer's
evidence a sufficient answer? Record each as `resolved`, `explanation
accepted`, or `unresolved — <why>`, examining the delta first and the wider
diff only where a correction's risk reaches it. It approves or escalates under
the protocol's Rounds rule; there is no third round.

Read the earlier verdicts and corrections records on the PR before reporting.
A settled finding stays settled unless this head changed the affected behavior
or the review has new reproducible evidence that materially changes its
consequence. In that case, reopen the existing finding id and state the new
evidence; do not file the same observation under a new id or re-argue severity
from preference alone.

Review exactly the head you were given. If the pull request's head moves while
you review, stop with `defer`: a review of another head satisfies nothing.

## Reviewer outcomes and handoff

- `approve` — a full review with no findings or only P3s; a corrections review
  that resolves every listed P1 and P2 and introduces none.
- `changes` — a full review finds a P1 or P2.
- `needs-human` — a corrections review leaves a P1 or P2 unresolved or finds
  a new one; follow [human-decisions.md](human-decisions.md).
- `defer` — the head moved during review, or a document the judgment needs
  could not be read.

Post the verdict once as a review on the assigned head:
`gh pr review <N> --comment --body-file <file>`, which records that commit.
It opens with `Verdict: <no findings | P1 <n>, P2 <n>, P3 <n>>` or the corrections
resolutions, then the findings; the summary links it.

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

When a PR settles a choice that passes
[`delivery-policy.md`'s when-to-record test](delivery-policy.md#decision-records)
but has no record, raise a finding; the reviewer does not draft it. The
implementer supplies the complete record in the same PR under
[`implementer.md`'s Decision records](../roles/implementer.md#decision-records),
as a drafted initial stance or a linked boundary `open` recommendation. Verify
the draft or open record like any other correction, while it is still editable;
do not hold the PR for a person's confirmation of that record. Review and merge gates
remain owed.

## Handing findings over

Three records carry findings between implementer and reviewer, so no separate
ledger is kept:

1. The verdict lists every finding.
2. The implementer's revision summary lists every id once, as `corrected in
   <sha>` or `answered: <evidence>`.
3. The corrections review marks every listed id `resolved`, `explanation
   accepted` or `unresolved — <why>`.

When an optional Copilot review has posted findings, one revision answers
whatever both reviews have posted. Copilot's remarks carry no finding ids:
they are corrected or answered in their own threads, and any still open at
integration are the integrator's to answer. Its absence or pending status is
not a reason to wait; the delivery policy governs optional review requests.

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

The count starts again in three cases. A full review the integrator requests
with `review` is the first round of a new count; one that lists finding ids is
the missing second round itself. A person's answer to an escalation makes the
next corrections review a fresh second round; the implementer asks for it when
the answer asks for verification or the rule above still requires one.

The first adopted clean refresh on a PR (`integration.md`'s matching durable
`base-refresh-adopted` record at the current NEW_SHA) starts a fresh full first
round at that head, even if the prior head exhausted its two rounds. This refresh
restart is allowed at most once per PR; later handoffs and substantive implementer
commits retain the count. Ordinary second-round and escalation limits apply
within it. Prior findings keep their recorded settlements, and new findings
follow the normal correction rule.

An issue gets one review pass (`issue-preparation.md`).

## Completion

The integrator checks the record rather than the code again: every P1 and P2 id
has a correction or an accepted answer, and a second round ran where this
protocol requires one. A P3 left untouched is accepted debt. Merge requires
`delivery-policy.md`'s gates and no open P1 or P2.
